// exercised by the hook bundle: imports must disappear at build time
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}
