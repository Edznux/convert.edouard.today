// app.js — I/O layer: DOM, file reading, wiring
// This is the only file that touches the DOM or performs I/O.

"use strict";

(function () {
    var dropZone = document.getElementById("drop-zone");
    var fileInput = document.getElementById("file-input");
    var status = document.getElementById("status");
    var results = document.getElementById("results");
    var blobUrls = [];

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

    // --- Cleanup ---

    function clearResults() {
        blobUrls.forEach(function (url) {
            URL.revokeObjectURL(url);
        });
        blobUrls = [];
        results.innerHTML = "";
        results.hidden = true;
    }

    // --- File conversion (returns a Promise) ---

    function convertFile(file) {
        return new Promise(function (resolve, reject) {
            if (!file.name.toLowerCase().endsWith(".fit")) {
                reject(new Error("Not a .FIT file: " + file.name));
                return;
            }
            var reader = new FileReader();
            reader.onerror = function () {
                reject(new Error("Failed to read: " + file.name));
            };
            reader.onload = function () {
                try {
                    var result = FIT.parseFitFile(reader.result);
                    if (result.trackpoints.length === 0) {
                        reject(new Error("No GPS data: " + file.name));
                        return;
                    }
                    var gpxString = GPX.buildGpx(result.trackpoints);
                    var gpxFilename = file.name.replace(/\.fit$/i, ".gpx");
                    resolve({
                        filename: gpxFilename,
                        gpx: gpxString,
                        trackpoints: result.trackpoints.length
                    });
                } catch (e) {
                    reject(new Error(file.name + ": " + e.message));
                }
            };
            reader.readAsArrayBuffer(file);
        });
    }

    // --- Process multiple files ---

    function processFiles(fileList) {
        hideStatus();
        clearResults();

        var files = [];
        for (var i = 0; i < fileList.length; i++) {
            files.push(fileList[i]);
        }

        Promise.allSettled(files.map(convertFile)).then(function (settled) {
            var successes = [];
            var errors = [];
            settled.forEach(function (r) {
                if (r.status === "fulfilled") successes.push(r.value);
                else errors.push(r.reason.message);
            });

            if (successes.length === 0) {
                showStatus(errors.join("\n"), true);
                return;
            }

            var totalTp = successes.reduce(function (s, r) { return s + r.trackpoints; }, 0);
            var msg = successes.length + " file" + (successes.length > 1 ? "s" : "") +
                      " converted (" + totalTp + " trackpoints).";
            if (errors.length > 0) {
                msg += "\n" + errors.length + " failed: " + errors.join("; ");
            }
            showStatus(msg, false);

            successes.forEach(function (r) {
                var blob = new Blob([r.gpx], { type: "application/gpx+xml" });
                var url = URL.createObjectURL(blob);
                blobUrls.push(url);

                var a = document.createElement("a");
                a.href = url;
                a.download = r.filename;
                a.className = "download-btn";
                a.textContent = r.filename;
                results.appendChild(a);
            });
            results.hidden = false;
        });
    }

    // --- File input ---

    fileInput.addEventListener("change", function () {
        if (fileInput.files.length > 0) {
            processFiles(fileInput.files);
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
            processFiles(e.dataTransfer.files);
        }
    });

    // Clicking the drop zone also opens the file picker
    dropZone.addEventListener("click", function (e) {
        if (e.target !== fileInput && !e.target.closest(".file-label")) {
            fileInput.click();
        }
    });
})();
