
(() => {
  const GITHUB_OWNER = "YOUR_GITHUB_USERNAME";
  const GITHUB_REPO = "YOUR_REPOSITORY_NAME";

  // বর্তমান ইনস্টল করা অ্যাপের ভার্সন
  const CURRENT_VERSION = "1.0.3";

  async function checkForUpdate() {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
        { cache: "no-store" }
      );

      if (!response.ok) throw new Error("Update check failed");

      const release = await response.json();
      const apk = release.assets?.find(asset =>
        asset.name.toLowerCase().endsWith(".apk")
      );

      if (!apk || !release.tag_name) return;

      const latestVersion = release.tag_name.replace(/^v/, "");

      const current = CURRENT_VERSION.split(".").map(Number);
      const latest = latestVersion.split(".").map(Number);

      let newer = false;

      for (let i = 0; i < Math.max(current.length, latest.length); i++) {
        const a = current[i] || 0;
        const b = latest[i] || 0;

        if (b > a) { newer = true; break; }
        if (b < a) break;
      }

      if (!newer) return;

      const update = document.createElement("div");
      update.id = "app-update-notice";
      update.style.cssText = `
        position:fixed; inset:0; z-index:999999;
        background:#0009; display:flex;
        align-items:center; justify-content:center;
        padding:20px; font-family:Arial,sans-serif;
      `;

      update.innerHTML = `
        <div style="background:white;color:#172033;
          border-radius:18px;padding:24px;
          width:100%;max-width:360px;text-align:center">
          <h2>নতুন আপডেট এসেছে!</h2>
          <p>বর্তমান ভার্সন: ${CURRENT_VERSION}</p>
          <p>নতুন ভার্সন: ${latestVersion}</p>
          <p>নতুন ফিচার ও উন্নত অভিজ্ঞতার জন্য আপডেট করুন।</p>
          <a href="${apk.browser_download_url}"
             target="_blank" rel="noopener noreferrer"
             style="display:block;background:#155eef;color:white;
             padding:14px;border-radius:10px;text-decoration:none">
             Update Now
          </a>
          <button id="dismiss-update"
            style="margin-top:14px;padding:10px 18px">
            Later
          </button>
        </div>
      `;

      document.body.appendChild(update);

      document.getElementById("dismiss-update").onclick =
        () => update.remove();

    } catch (error) {
      console.error("Update check:", error);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkForUpdate);
  } else {
    checkForUpdate();
  }
})();
