// app.js — I/O layer: DOM, file reading, wiring
// This is the only file that touches the DOM or performs I/O.

"use strict";

(function () {
    var dropZone = document.getElementById("drop-zone");
    var fileInput = document.getElementById("file-input");
    var status = document.getElementById("status");
    var downloadLink = document.getElementById("download-link");

    // --- Service worker registration ---

    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("sw.js");
    }

    // --- Status display ---

    function showStatus(message, isError) {
        status.textContent = message;
        status.className = isError ? "error" : "success";
        status.hidden = false;
    }

    function hideStatus() {
        status.hidden = true;
    }

    // --- File processing ---

    function processFile(file) {
        hideStatus();
        downloadLink.hidden = true;

        if (!file.name.toLowerCase().endsWith(".fit")) {
            showStatus("Please select a .FIT file.", true);
            return;
        }

        var reader = new FileReader();

        reader.onerror = function () {
            showStatus("Failed to read file.", true);
        };

        reader.onload = function () {
            try {
                var result = FIT.parseFitFile(reader.result);

                if (result.trackpoints.length === 0) {
                    showStatus("No GPS trackpoints found in this file.", true);
                    return;
                }

                var gpxString = GPX.buildGpx(result.trackpoints);
                var blob = new Blob([gpxString], { type: "application/gpx+xml" });
                var url = URL.createObjectURL(blob);

                var gpxFilename = file.name.replace(/\.fit$/i, ".gpx");
                downloadLink.href = url;
                downloadLink.download = gpxFilename;
                downloadLink.hidden = false;

                showStatus(
                    result.trackpoints.length + " trackpoints converted.",
                    false
                );
            } catch (e) {
                showStatus(e.message, true);
            }
        };

        reader.readAsArrayBuffer(file);
    }

    // --- File input ---

    fileInput.addEventListener("change", function () {
        if (fileInput.files.length > 0) {
            processFile(fileInput.files[0]);
        }
    });

    // --- Drag and drop ---

    dropZone.addEventListener("dragover", function (e) {
        e.preventDefault();
        dropZone.classList.add("dragover");
    });

    dropZone.addEventListener("dragleave", function () {
        dropZone.classList.remove("dragover");
    });

    dropZone.addEventListener("drop", function (e) {
        e.preventDefault();
        dropZone.classList.remove("dragover");

        if (e.dataTransfer.files.length > 0) {
            processFile(e.dataTransfer.files[0]);
        }
    });

    // Clicking the drop zone also opens the file picker
    dropZone.addEventListener("click", function (e) {
        if (e.target !== fileInput && !e.target.closest(".file-label")) {
            fileInput.click();
        }
    });
})();
