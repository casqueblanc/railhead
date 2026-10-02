/**
 * The upload page. The script sends the chosen file as one request body and shows the server's
 * answer as text, never as markup.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Upload</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
      output { display: block; margin-top: 1rem; }
    </style>
  </head>
  <body>
    <h1>Upload a file</h1>
    <form id="upload">
      <input type="file" name="file" required />
      <button type="submit">Upload</button>
    </form>
    <output id="status" role="status" aria-live="polite"></output>
    <script>
      const form = document.getElementById("upload");
      const status = document.getElementById("status");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const file = form.elements.file.files[0];
        if (!file) return;
        status.textContent = "Uploading…";
        try {
          const response = await fetch("/api/uploads", {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: file,
          });
          const data = await response.json().catch(() => null);
          status.textContent = response.ok && data && typeof data.size === "number"
            ? "Uploaded " + data.size + " bytes."
            : (data && typeof data.error === "string" ? data.error : "Upload failed (" + response.status + ").");
        } catch {
          status.textContent = "Upload failed: the connection was lost.";
        }
      });
    </script>
  </body>
</html>
`;
