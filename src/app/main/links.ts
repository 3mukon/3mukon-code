// shell.openExternal hands a URL to macOS, which opens file: and custom schemes with whichever app
// claims them, so only web links may leave the app.
export function isWebUrl(url: string): boolean {
  const protocol = URL.parse(url)?.protocol;
  return protocol === 'https:' || protocol === 'http:';
}

// Whether a frame shows the app's own page, given the URL the window loads: the built page's file
// itself, or under electron-vite dev any page of the dev server.
export function isAppPage(url: string, page: string): boolean {
  const frame = URL.parse(url);
  const own = URL.parse(page);
  if (frame === null || own === null) return false;
  if (own.protocol !== 'file:') return frame.origin === own.origin;
  return frame.protocol === 'file:' && frame.pathname === own.pathname;
}
