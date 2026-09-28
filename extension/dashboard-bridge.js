(() => {
  const SOURCE_DASHBOARD = "QUG_DASHBOARD";
  const SOURCE_EXTENSION = "QUG_EXTENSION";

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE_DASHBOARD) return;
    const { requestId, action, payload } = event.data;
    if (!requestId || !action) return;

    chrome.runtime.sendMessage({ action, payload }, (response) => {
      const error = chrome.runtime.lastError;
      window.postMessage(
        {
          source: SOURCE_EXTENSION,
          requestId,
          response: error ? { ok: false, error: error.message } : response,
        },
        "*"
      );
    });
  });
})();
