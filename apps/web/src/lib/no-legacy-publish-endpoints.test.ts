const sources = import.meta.glob<string>(['/src/**/*.ts', '/src/**/*.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

const LEGACY = /playlists\/(mix|discover)\b/

describe('legacy publish-on-generate endpoints', () => {
  it('are not referenced by any web source file', () => {
    const production = Object.entries(sources).filter(
      ([path]) => !/\.test\.tsx?$/.test(path),
    )
    expect(production.length).toBeGreaterThan(100)

    const offenders = production
      .filter(([, content]) => LEGACY.test(content))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })
})
