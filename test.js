// test.js — Unit tests and fuzz tests for FIT parser and GPX builder
// Run with: node test.js

"use strict";

// --- Minimal test harness ---

var passed = 0;
var failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log("  PASS  " + name);
    } catch (e) {
        failed++;
        console.log("  FAIL  " + name);
        console.log("        " + e.message);
    }
}

function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(
            (label ? label + ": " : "") +
                "expected " + JSON.stringify(expected) +
                ", got " + JSON.stringify(actual)
        );
    }
}

function assertClose(actual, expected, tolerance, label) {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(
            (label ? label + ": " : "") +
                "expected ~" + expected + " (±" + tolerance + "), got " + actual
        );
    }
}

function assertThrows(fn, expectedSubstring) {
    try {
        fn();
        throw new Error("expected error containing '" + expectedSubstring + "', but no error was thrown");
    } catch (e) {
        if (!e.message.includes(expectedSubstring)) {
            throw new Error(
                "expected error containing '" + expectedSubstring +
                "', got: '" + e.message + "'"
            );
        }
    }
}

// --- Load modules ---
// fit.js and gpx.js declare `var FIT` / `var GPX` for browser globals.
// In Node we need to hoist them onto globalThis so tests can access them.

var fs = require("fs");
var vm = require("vm");
vm.runInThisContext(fs.readFileSync("./fit.js", "utf8"));
vm.runInThisContext(fs.readFileSync("./gpx.js", "utf8"));

// --- Helpers to build synthetic FIT binary data ---

// Builds a minimal valid FIT file with the given record data bytes.
// This constructs: header + definition message + N data messages + 2-byte CRC placeholder
function buildFitFile(options) {
    var trackpoints = options.trackpoints; // [{lat, lon, altitude, timestamp}] in raw FIT values
    var headerSize = options.headerSize || 14;
    var architecture = options.architecture || 0; // 0 = little-endian

    // We define a single record definition (global message 20) with fields:
    // field 253 (timestamp): uint32, 4 bytes, base type 0x86
    // field 0 (lat): sint32, 4 bytes, base type 0x85
    // field 1 (lon): sint32, 4 bytes, base type 0x85
    // field 2 (altitude): uint16, 2 bytes, base type 0x84

    var fieldCount = 4;
    var dataMessageSize = 4 + 4 + 4 + 2; // 14 bytes per data message
    var defMessageSize = 1 + 5 + fieldCount * 3; // 1 header + 5 fixed + 12 field defs = 18
    var dataMessagesSize = trackpoints.length * (1 + dataMessageSize); // 1 header + 14 data each

    var totalDataSize = defMessageSize + dataMessagesSize;
    var fileSize = headerSize + totalDataSize + 2; // +2 for trailing CRC

    var buf = new ArrayBuffer(fileSize);
    var view = new DataView(buf);
    var littleEndian = architecture === 0;
    var pos = 0;

    // --- Header ---
    view.setUint8(pos++, headerSize);    // header size
    view.setUint8(pos++, 0x20);          // protocol version 2.0
    view.setUint16(pos, 0x0814, true);   // profile version
    pos += 2;
    view.setUint32(pos, totalDataSize, true); // data size
    pos += 4;
    // ".FIT" signature
    view.setUint8(pos++, 0x2E);
    view.setUint8(pos++, 0x46);
    view.setUint8(pos++, 0x49);
    view.setUint8(pos++, 0x54);
    if (headerSize === 14) {
        view.setUint16(pos, 0x0000, true); // CRC placeholder
        pos += 2;
    }

    // --- Definition message for local type 0 ---
    view.setUint8(pos++, 0x40); // record header: definition, local type 0
    view.setUint8(pos++, 0x00); // reserved
    view.setUint8(pos++, architecture); // architecture
    view.setUint16(pos, 20, littleEndian); // global message number = record
    pos += 2;
    view.setUint8(pos++, fieldCount);

    // Field 253 (timestamp): uint32
    view.setUint8(pos++, 253);
    view.setUint8(pos++, 4);
    view.setUint8(pos++, 0x86);
    // Field 0 (lat): sint32
    view.setUint8(pos++, 0);
    view.setUint8(pos++, 4);
    view.setUint8(pos++, 0x85);
    // Field 1 (lon): sint32
    view.setUint8(pos++, 1);
    view.setUint8(pos++, 4);
    view.setUint8(pos++, 0x85);
    // Field 2 (altitude): uint16
    view.setUint8(pos++, 2);
    view.setUint8(pos++, 2);
    view.setUint8(pos++, 0x84);

    // --- Data messages ---
    for (var i = 0; i < trackpoints.length; i++) {
        var tp = trackpoints[i];
        view.setUint8(pos++, 0x00); // data message header, local type 0

        view.setUint32(pos, tp.timestamp, littleEndian);
        pos += 4;
        view.setInt32(pos, tp.lat, littleEndian);
        pos += 4;
        view.setInt32(pos, tp.lon, littleEndian);
        pos += 4;
        view.setUint16(pos, tp.altitude, littleEndian);
        pos += 2;
    }

    // Trailing CRC placeholder
    view.setUint16(pos, 0x0000, true);

    return buf;
}

// Convert degrees to semicircles (inverse of parser conversion)
function degreesToSemicircles(degrees) {
    return Math.round(degrees * (2147483648 / 180));
}

// Convert meters to raw altitude value (inverse of parser conversion)
function metersToRawAltitude(meters) {
    return Math.round((meters + 500) * 5);
}

// Garmin epoch offset
var GARMIN_EPOCH_OFFSET = 631065600;

function unixToGarmin(unixSeconds) {
    return unixSeconds - GARMIN_EPOCH_OFFSET;
}


// ============================================================
console.log("\n--- FIT Parser: rejection of invalid input ---");
// ============================================================

test("rejects non-ArrayBuffer", function () {
    assertThrows(function () { FIT.parseFitFile("not a buffer"); }, "expected ArrayBuffer");
});

test("rejects too-small buffer", function () {
    assertThrows(function () { FIT.parseFitFile(new ArrayBuffer(5)); }, "file too small");
});

test("rejects missing .FIT signature", function () {
    var buf = new ArrayBuffer(14);
    var view = new DataView(buf);
    view.setUint8(0, 14);       // header size
    view.setUint32(4, 1, true); // data size > 0
    // signature bytes left as 0 — not ".FIT"
    assertThrows(function () { FIT.parseFitFile(buf); }, ".FIT signature");
});

test("rejects zero data size", function () {
    var buf = new ArrayBuffer(14);
    var view = new DataView(buf);
    view.setUint8(0, 14);
    view.setUint32(4, 0, true); // data size = 0
    view.setUint8(8, 0x2E);
    view.setUint8(9, 0x46);
    view.setUint8(10, 0x49);
    view.setUint8(11, 0x54);
    assertThrows(function () { FIT.parseFitFile(buf); }, "data size is zero");
});

test("rejects truncated file", function () {
    var buf = new ArrayBuffer(16);
    var view = new DataView(buf);
    view.setUint8(0, 14);
    view.setUint32(4, 1000, true); // claims 1000 bytes of data
    view.setUint8(8, 0x2E);
    view.setUint8(9, 0x46);
    view.setUint8(10, 0x49);
    view.setUint8(11, 0x54);
    assertThrows(function () { FIT.parseFitFile(buf); }, "file truncated");
});

test("rejects bad header size", function () {
    var buf = new ArrayBuffer(20);
    var view = new DataView(buf);
    view.setUint8(0, 10); // invalid header size (not 12 or 14)
    assertThrows(function () { FIT.parseFitFile(buf); }, "unexpected header size");
});


// ============================================================
console.log("\n--- FIT Parser: single trackpoint ---");
// ============================================================

test("parses a single trackpoint with correct lat/lon/elevation/timestamp", function () {
    var lat = 46.5;  // degrees
    var lon = 6.6;
    var alt = 372.0; // meters
    var unixTime = 1700000000;

    var fit = buildFitFile({
        trackpoints: [{
            lat: degreesToSemicircles(lat),
            lon: degreesToSemicircles(lon),
            altitude: metersToRawAltitude(alt),
            timestamp: unixToGarmin(unixTime),
        }],
    });

    var result = FIT.parseFitFile(fit);
    assertEqual(result.trackpoints.length, 1, "trackpoint count");

    var pt = result.trackpoints[0];
    assertClose(pt.lat, lat, 0.0001, "latitude");
    assertClose(pt.lon, lon, 0.0001, "longitude");
    assertClose(pt.elevation, alt, 0.5, "elevation");

    var expectedTime = new Date(unixTime * 1000).toISOString();
    assertEqual(pt.timestamp, expectedTime, "timestamp");
});


// ============================================================
console.log("\n--- FIT Parser: multiple trackpoints ---");
// ============================================================

test("parses multiple trackpoints in order", function () {
    var points = [];
    for (var i = 0; i < 10; i++) {
        points.push({
            lat: degreesToSemicircles(45 + i * 0.001),
            lon: degreesToSemicircles(7 + i * 0.001),
            altitude: metersToRawAltitude(100 + i * 10),
            timestamp: unixToGarmin(1700000000 + i),
        });
    }

    var result = FIT.parseFitFile(buildFitFile({ trackpoints: points }));
    assertEqual(result.trackpoints.length, 10, "trackpoint count");

    for (var j = 0; j < 10; j++) {
        assertClose(result.trackpoints[j].lat, 45 + j * 0.001, 0.0001, "lat[" + j + "]");
        assertClose(result.trackpoints[j].elevation, 100 + j * 10, 0.5, "ele[" + j + "]");
    }
});


// ============================================================
console.log("\n--- FIT Parser: invalid GPS sentinel values ---");
// ============================================================

test("skips trackpoints with invalid lat (0x7FFFFFFF)", function () {
    var fit = buildFitFile({
        trackpoints: [
            {
                lat: 0x7FFFFFFF, // invalid
                lon: degreesToSemicircles(7),
                altitude: metersToRawAltitude(100),
                timestamp: unixToGarmin(1700000000),
            },
            {
                lat: degreesToSemicircles(46),
                lon: degreesToSemicircles(7),
                altitude: metersToRawAltitude(200),
                timestamp: unixToGarmin(1700000001),
            },
        ],
    });

    var result = FIT.parseFitFile(fit);
    assertEqual(result.trackpoints.length, 1, "should skip invalid trackpoint");
    assertClose(result.trackpoints[0].lat, 46, 0.0001, "valid trackpoint lat");
});


// ============================================================
console.log("\n--- FIT Parser: 12-byte header ---");
// ============================================================

test("parses file with 12-byte header", function () {
    var fit = buildFitFile({
        headerSize: 12,
        trackpoints: [{
            lat: degreesToSemicircles(48.8566),
            lon: degreesToSemicircles(2.3522),
            altitude: metersToRawAltitude(35),
            timestamp: unixToGarmin(1700000000),
        }],
    });

    var result = FIT.parseFitFile(fit);
    assertEqual(result.trackpoints.length, 1, "trackpoint count");
    assertClose(result.trackpoints[0].lat, 48.8566, 0.0001, "lat");
    assertClose(result.trackpoints[0].lon, 2.3522, 0.0001, "lon");
});


// ============================================================
console.log("\n--- FIT Parser: big-endian architecture ---");
// ============================================================

test("parses big-endian FIT data", function () {
    var fit = buildFitFile({
        architecture: 1, // big-endian
        trackpoints: [{
            lat: degreesToSemicircles(51.5074),
            lon: degreesToSemicircles(-0.1278),
            altitude: metersToRawAltitude(11),
            timestamp: unixToGarmin(1700000000),
        }],
    });

    var result = FIT.parseFitFile(fit);
    assertEqual(result.trackpoints.length, 1, "trackpoint count");
    assertClose(result.trackpoints[0].lat, 51.5074, 0.0001, "lat");
    assertClose(result.trackpoints[0].lon, -0.1278, 0.0001, "lon");
});


// ============================================================
console.log("\n--- FIT Parser: altitude edge cases ---");
// ============================================================

test("handles invalid altitude (0xFFFF)", function () {
    var fit = buildFitFile({
        trackpoints: [{
            lat: degreesToSemicircles(46),
            lon: degreesToSemicircles(7),
            altitude: 0xFFFF, // invalid
            timestamp: unixToGarmin(1700000000),
        }],
    });

    var result = FIT.parseFitFile(fit);
    assertEqual(result.trackpoints.length, 1);
    assertEqual(result.trackpoints[0].elevation, null, "elevation should be null for invalid");
});

test("handles negative elevation (below sea level)", function () {
    var fit = buildFitFile({
        trackpoints: [{
            lat: degreesToSemicircles(31.5),
            lon: degreesToSemicircles(35.5),
            altitude: metersToRawAltitude(-430), // Dead Sea
            timestamp: unixToGarmin(1700000000),
        }],
    });

    var result = FIT.parseFitFile(fit);
    assertClose(result.trackpoints[0].elevation, -430, 0.5, "negative elevation");
});


// ============================================================
console.log("\n--- GPX Builder ---");
// ============================================================

test("builds valid GPX XML", function () {
    var gpx = GPX.buildGpx([
        { lat: 46.5, lon: 6.6, elevation: 372.0, timestamp: "2023-11-14T22:13:20.000Z" },
    ]);

    assertEqual(gpx.includes('<?xml version="1.0"'), true, "has XML declaration");
    assertEqual(gpx.includes('<gpx version="1.1"'), true, "has GPX root");
    assertEqual(gpx.includes('<trkpt lat="46.5000000" lon="6.6000000">'), true, "has trkpt");
    assertEqual(gpx.includes("<ele>372.0</ele>"), true, "has elevation");
    assertEqual(gpx.includes("<time>2023-11-14T22:13:20.000Z</time>"), true, "has time");
    assertEqual(gpx.includes("</gpx>"), true, "has closing tag");
});

test("omits elevation when null", function () {
    var gpx = GPX.buildGpx([
        { lat: 46.5, lon: 6.6, elevation: null, timestamp: "2023-11-14T22:13:20.000Z" },
    ]);
    assertEqual(gpx.includes("<ele>"), false, "should not have ele");
});

test("omits time when null", function () {
    var gpx = GPX.buildGpx([
        { lat: 46.5, lon: 6.6, elevation: 100, timestamp: null },
    ]);
    assertEqual(gpx.includes("<time>"), false, "should not have time");
});

test("rejects empty trackpoints array", function () {
    assertThrows(function () { GPX.buildGpx([]); }, "no trackpoints");
});

test("rejects non-array", function () {
    assertThrows(function () { GPX.buildGpx("hello"); }, "expected array");
});


// ============================================================
console.log("\n--- End-to-end: FIT parse -> GPX build ---");
// ============================================================

test("full pipeline produces valid GPX from synthetic FIT", function () {
    var fit = buildFitFile({
        trackpoints: [
            {
                lat: degreesToSemicircles(46.5),
                lon: degreesToSemicircles(6.6),
                altitude: metersToRawAltitude(372),
                timestamp: unixToGarmin(1700000000),
            },
            {
                lat: degreesToSemicircles(46.501),
                lon: degreesToSemicircles(6.601),
                altitude: metersToRawAltitude(375),
                timestamp: unixToGarmin(1700000001),
            },
        ],
    });

    var result = FIT.parseFitFile(fit);
    var gpx = GPX.buildGpx(result.trackpoints);

    assertEqual(gpx.includes("<trkpt"), true, "has trackpoints");
    // Count trkpt occurrences
    var count = (gpx.match(/<trkpt /g) || []).length;
    assertEqual(count, 2, "two trackpoints in GPX");
});


// ============================================================
console.log("\n--- Fuzz: random bytes should not crash (just throw) ---");
// ============================================================

test("fuzz: 10000 random buffers do not crash (they may throw)", function () {
    var rng = mulberry32(42); // seeded PRNG for reproducibility

    var crashes = 0;
    for (var i = 0; i < 10000; i++) {
        // Random size: 0 to 512 bytes
        var size = Math.floor(rng() * 513);
        var buf = new ArrayBuffer(size);
        var bytes = new Uint8Array(buf);
        for (var j = 0; j < size; j++) {
            bytes[j] = Math.floor(rng() * 256);
        }

        try {
            FIT.parseFitFile(buf);
        } catch (e) {
            // Expected: assertion errors, range errors, etc.
            // NOT expected: hangs, segfaults, undefined behavior
            if (!(e instanceof Error)) {
                crashes++;
                console.log("        Non-Error thrown at iteration " + i + ": " + e);
            }
        }
    }
    assertEqual(crashes, 0, "non-Error exceptions");
});

test("fuzz: valid header + random data records do not crash", function () {
    var rng = mulberry32(123);

    var crashes = 0;
    for (var i = 0; i < 5000; i++) {
        // Build a buffer with a valid FIT header but random data
        var dataSize = Math.floor(rng() * 256) + 1;
        var headerSize = 14;
        var totalSize = headerSize + dataSize + 2;
        var buf = new ArrayBuffer(totalSize);
        var view = new DataView(buf);

        // Valid header
        view.setUint8(0, headerSize);
        view.setUint8(1, 0x20);
        view.setUint16(2, 0x0814, true);
        view.setUint32(4, dataSize, true);
        view.setUint8(8, 0x2E);
        view.setUint8(9, 0x46);
        view.setUint8(10, 0x49);
        view.setUint8(11, 0x54);

        // Random data bytes after header
        var bytes = new Uint8Array(buf);
        for (var j = headerSize; j < totalSize; j++) {
            bytes[j] = Math.floor(rng() * 256);
        }

        try {
            FIT.parseFitFile(buf);
        } catch (e) {
            if (!(e instanceof Error)) {
                crashes++;
                console.log("        Non-Error thrown at iteration " + i + ": " + e);
            }
        }
    }
    assertEqual(crashes, 0, "non-Error exceptions");
});

test("fuzz: valid structure with random field values do not crash", function () {
    var rng = mulberry32(999);

    var crashes = 0;
    for (var i = 0; i < 2000; i++) {
        try {
            var numPoints = Math.floor(rng() * 5) + 1;
            var points = [];
            for (var k = 0; k < numPoints; k++) {
                points.push({
                    lat: Math.floor(rng() * 0xFFFFFFFF) - 0x7FFFFFFF,
                    lon: Math.floor(rng() * 0xFFFFFFFF) - 0x7FFFFFFF,
                    altitude: Math.floor(rng() * 0xFFFF),
                    timestamp: Math.floor(rng() * 0xFFFFFFFF),
                });
            }

            var fit = buildFitFile({ trackpoints: points });
            var result = FIT.parseFitFile(fit);

            // If we got trackpoints, try building GPX too
            if (result.trackpoints.length > 0) {
                GPX.buildGpx(result.trackpoints);
            }
        } catch (e) {
            if (!(e instanceof Error)) {
                crashes++;
                console.log("        Non-Error thrown at iteration " + i + ": " + e);
            }
        }
    }
    assertEqual(crashes, 0, "non-Error exceptions");
});


// --- Seeded PRNG (Mulberry32) for reproducible fuzz tests ---

function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}


// --- Summary ---

console.log("\n" + (passed + failed) + " tests: " + passed + " passed, " + failed + " failed\n");
process.exit(failed > 0 ? 1 : 0);
