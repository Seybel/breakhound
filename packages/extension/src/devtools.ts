// With a callback, so a failure is reported here instead of as an uncaught promise.
chrome.devtools.panels.create('breakhound', 'icons/32.png', 'panel.html', () => {});
