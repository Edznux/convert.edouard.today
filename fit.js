// fit.js — Pure FIT file parser (SanSIO: no I/O, no DOM, no side effects)
// Tiger Style: assert at every boundary, explicit control flow

"use strict";

function assert(condition, message) {
    if (!condition) throw new Error("FIT parse error: " + message);
}

var FIT = (function () {
    // --- Constants ---

    var GARMIN_EPOCH_OFFSET = 631065600;
    var SEMICIRCLES_TO_DEGREES = 180 / 2147483648;

    var INVALID_SINT32 = 0x7FFFFFFF;
    var INVALID_UINT32 = 0xFFFFFFFF;
    var INVALID_UINT16 = 0xFFFF;

    var MESG_NUM_RECORD = 20;

    var FIELD_TIMESTAMP = 253;
    var FIELD_POSITION_LAT = 0;
    var FIELD_POSITION_LONG = 1;
    var FIELD_ALTITUDE = 2;
    var FIELD_ENHANCED_ALTITUDE = 78;

    // --- Header parsing ---

    function parseFitHeader(view) {
        assert(view.byteLength >= 12, "file too small for FIT header");

        var headerSize = view.getUint8(0);
        assert(headerSize === 12 || headerSize === 14, "unexpected header size: " + headerSize);

        var dataSize = view.getUint32(4, true);
        assert(dataSize > 0, "data size is zero");

        var d0 = view.getUint8(8);
        var d1 = view.getUint8(9);
        var d2 = view.getUint8(10);
        var d3 = view.getUint8(11);
        assert(
            d0 === 0x2E && d1 === 0x46 && d2 === 0x49 && d3 === 0x54,
            "missing .FIT signature"
        );

        return { headerSize: headerSize, dataSize: dataSize };
    }

    // --- Record header parsing ---

    function parseRecordHeader(byte) {
        if (byte & 0x80) {
            // Compressed timestamp header
            return {
                isDefinition: false,
                isCompressedTimestamp: true,
                localMessageType: (byte >> 5) & 0x03,
                timeOffset: byte & 0x1F,
                hasDeveloperData: false,
            };
        }
        // Normal header
        return {
            isDefinition: (byte & 0x40) !== 0,
            isCompressedTimestamp: false,
            localMessageType: byte & 0x0F,
            timeOffset: 0,
            hasDeveloperData: (byte & 0x20) !== 0,
        };
    }

    // --- Definition message parsing ---

    function parseDefinitionMessage(view, offset, hasDeveloperData) {
        // byte 0: reserved
        var architecture = view.getUint8(offset + 1);
        var littleEndian = architecture === 0;
        var globalMessageNumber = view.getUint16(offset + 2, littleEndian);
        var fieldCount = view.getUint8(offset + 4);

        var fieldDefs = [];
        var pos = offset + 5;

        for (var i = 0; i < fieldCount; i++) {
            fieldDefs.push({
                fieldDefNum: view.getUint8(pos),
                size: view.getUint8(pos + 1),
                baseType: view.getUint8(pos + 2),
            });
            pos += 3;
        }

        // Skip developer field definitions if present
        var devFieldCount = 0;
        if (hasDeveloperData) {
            devFieldCount = view.getUint8(pos);
            pos += 1 + devFieldCount * 3;
        }

        // Compute total data size for data messages using this definition
        var dataSize = 0;
        for (var j = 0; j < fieldDefs.length; j++) {
            dataSize += fieldDefs[j].size;
        }

        // Compute developer data size
        // We don't parse dev fields but need to skip them in data messages
        // Dev field definitions: each has fieldNum(1), size(1), devDataIndex(1)
        // We need the sizes to skip in data messages
        var devFieldSizes = [];
        if (hasDeveloperData && devFieldCount > 0) {
            var devPos = offset + 5 + fieldCount * 3 + 1; // after dev field count byte
            for (var k = 0; k < devFieldCount; k++) {
                devFieldSizes.push(view.getUint8(devPos + 1)); // size byte
                devPos += 3;
            }
        }
        var devDataSize = 0;
        for (var m = 0; m < devFieldSizes.length; m++) {
            devDataSize += devFieldSizes[m];
        }

        return {
            globalMessageNumber: globalMessageNumber,
            littleEndian: littleEndian,
            fieldDefs: fieldDefs,
            dataSize: dataSize,
            devDataSize: devDataSize,
            totalDefSize: pos - offset,
        };
    }

    // --- Field value reading ---

    function readFieldValue(view, offset, size, baseType, littleEndian) {
        var typeIndex = baseType & 0x1F;

        switch (typeIndex) {
            case 0: // enum
            case 2: // uint8
            case 10: // uint8z
            case 13: // byte
                return view.getUint8(offset);
            case 1: // sint8
                return view.getInt8(offset);
            case 3: // sint16
                if (size >= 2) return view.getInt16(offset, littleEndian);
                return view.getInt8(offset);
            case 4: // uint16
            case 11: // uint16z
                if (size >= 2) return view.getUint16(offset, littleEndian);
                return view.getUint8(offset);
            case 5: // sint32
                if (size >= 4) return view.getInt32(offset, littleEndian);
                if (size >= 2) return view.getInt16(offset, littleEndian);
                return view.getInt8(offset);
            case 6: // uint32
            case 12: // uint32z
                if (size >= 4) return view.getUint32(offset, littleEndian);
                if (size >= 2) return view.getUint16(offset, littleEndian);
                return view.getUint8(offset);
            case 8: // float32
                if (size >= 4) return view.getFloat32(offset, littleEndian);
                return null;
            case 9: // float64
                if (size >= 8) return view.getFloat64(offset, littleEndian);
                return null;
            case 7: // string
                return null; // we don't need strings
            default:
                return null;
        }
    }

    // --- Main parser ---

    function parseFitFile(arrayBuffer) {
        assert(arrayBuffer instanceof ArrayBuffer, "expected ArrayBuffer");
        assert(arrayBuffer.byteLength >= 14, "file too small");

        var view = new DataView(arrayBuffer);
        var header = parseFitHeader(view);
        var dataEnd = header.headerSize + header.dataSize;

        assert(
            arrayBuffer.byteLength >= dataEnd,
            "file truncated: expected " + dataEnd + " bytes, got " + arrayBuffer.byteLength
        );

        var definitions = {};
        var trackpoints = [];
        var lastTimestamp = 0;
        var offset = header.headerSize;

        while (offset < dataEnd) {
            var recordByte = view.getUint8(offset);
            offset += 1;

            var rh = parseRecordHeader(recordByte);

            if (rh.isDefinition) {
                var def = parseDefinitionMessage(view, offset, rh.hasDeveloperData);
                definitions[rh.localMessageType] = def;
                offset += def.totalDefSize;
                continue;
            }

            // Data message
            var defn = definitions[rh.localMessageType];
            assert(
                defn !== undefined,
                "data message for undefined local type " + rh.localMessageType + " at offset " + (offset - 1)
            );

            // Handle compressed timestamp
            if (rh.isCompressedTimestamp) {
                var newOffset = rh.timeOffset;
                var prevOffset = lastTimestamp & 0x1F;
                if (newOffset >= prevOffset) {
                    lastTimestamp = (lastTimestamp & 0xFFFFFFE0) + newOffset;
                } else {
                    lastTimestamp = (lastTimestamp & 0xFFFFFFE0) + 0x20 + newOffset;
                }
            }

            // Read fields
            var fields = {};
            var fieldOffset = offset;

            for (var i = 0; i < defn.fieldDefs.length; i++) {
                var fd = defn.fieldDefs[i];
                var val = readFieldValue(view, fieldOffset, fd.size, fd.baseType, defn.littleEndian);
                if (val !== null) {
                    fields[fd.fieldDefNum] = val;
                }
                fieldOffset += fd.size;
            }

            offset += defn.dataSize + defn.devDataSize;

            // Track timestamp from field 253
            if (fields[FIELD_TIMESTAMP] !== undefined) {
                lastTimestamp = fields[FIELD_TIMESTAMP];
            }

            // Only process record messages (global message 20)
            if (defn.globalMessageNumber !== MESG_NUM_RECORD) {
                continue;
            }

            var lat = fields[FIELD_POSITION_LAT];
            var lon = fields[FIELD_POSITION_LONG];

            // Skip trackpoints without valid GPS
            if (lat === undefined || lon === undefined) continue;
            if (lat === INVALID_SINT32 || lon === INVALID_SINT32) continue;

            var elevation = null;
            if (fields[FIELD_ENHANCED_ALTITUDE] !== undefined && fields[FIELD_ENHANCED_ALTITUDE] !== INVALID_UINT32) {
                elevation = fields[FIELD_ENHANCED_ALTITUDE] / 5 - 500;
            } else if (fields[FIELD_ALTITUDE] !== undefined && fields[FIELD_ALTITUDE] !== INVALID_UINT16) {
                elevation = fields[FIELD_ALTITUDE] / 5 - 500;
            }

            var timestamp = null;
            var ts = fields[FIELD_TIMESTAMP];
            if (ts !== undefined && ts !== INVALID_UINT32) {
                timestamp = new Date((ts + GARMIN_EPOCH_OFFSET) * 1000).toISOString();
            } else if (rh.isCompressedTimestamp) {
                timestamp = new Date((lastTimestamp + GARMIN_EPOCH_OFFSET) * 1000).toISOString();
            }

            trackpoints.push({
                lat: lat * SEMICIRCLES_TO_DEGREES,
                lon: lon * SEMICIRCLES_TO_DEGREES,
                elevation: elevation,
                timestamp: timestamp,
            });
        }

        return { trackpoints: trackpoints };
    }

    return { parseFitFile: parseFitFile };
})();
