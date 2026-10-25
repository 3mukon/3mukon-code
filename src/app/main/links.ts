// shell.openExternal hands a URL to macOS, which opens file: and custom schemes with whichever app
// claims them, so only web links may leave the app.
export function isWebUrl(url: string): boolean {
  const protocol = URL.parse(url)?.protocol;
  return protocol === 'https:' || protocol === 'http:';
}
