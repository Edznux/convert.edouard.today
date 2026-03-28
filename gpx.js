// gpx.js — Pure GPX XML builder (SanSIO: no I/O, no DOM, no side effects)
// Tiger Style: assert at every boundary

"use strict";

var GPX = (function () {
    function buildGpx(trackpoints) {
        assert(Array.isArray(trackpoints), "expected array of trackpoints");
        assert(trackpoints.length > 0, "no trackpoints to export");

        var lines = [];
        lines.push('<?xml version="1.0" encoding="UTF-8"?>');
        lines.push(
            '<gpx version="1.1" creator="fittogpx"' +
                ' xmlns="http://www.topografix.com/GPX/1/1"' +
                ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
                ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">'
        );
        lines.push("  <trk>");
        lines.push("    <trkseg>");

        for (var i = 0; i < trackpoints.length; i++) {
            var pt = trackpoints[i];
            lines.push(
                '      <trkpt lat="' +
                    pt.lat.toFixed(7) +
                    '" lon="' +
                    pt.lon.toFixed(7) +
                    '">'
            );
            if (pt.elevation !== null) {
                lines.push("        <ele>" + pt.elevation.toFixed(1) + "</ele>");
            }
            if (pt.timestamp !== null) {
                lines.push("        <time>" + pt.timestamp + "</time>");
            }
            lines.push("      </trkpt>");
        }

        lines.push("    </trkseg>");
        lines.push("  </trk>");
        lines.push("</gpx>");

        return lines.join("\n");
    }

    return { buildGpx: buildGpx };
})();
