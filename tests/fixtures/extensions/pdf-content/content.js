/* global browser */
document.documentElement.dataset.extensionContent = "ran"
browser.runtime.sendMessage({ url: location.href, contentType: document.contentType })
