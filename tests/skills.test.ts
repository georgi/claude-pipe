import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: vi.fn(actual.homedir)
  }
})

import { discoverSkills } from '../src/commands/skills.js'

const mockedHomedir = homedir as unknown as ReturnType<typeof vi.fn>

describe('discoverSkills', () => {
  let fakeHome: string

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'pi-pipe-skills-home-'))
    mockedHomedir.mockReturnValue(fakeHome)
  })

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function skillsDir(): string {
    return join(fakeHome, '.pi', 'agent', 'skills')
  }

  async function writeSkill(name: string, frontmatter: string): Promise<void> {
    const dir = join(skillsDir(), name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nbody`, 'utf-8')
  }

  it('returns [] when the skills directory does not exist', () => {
    expect(discoverSkills()).toEqual([])
  })

  it('discovers user-invocable skills with name + description', async () => {
    await writeSkill(
      'summarise',
      ['name: summarise', 'description: Summarise the workspace', 'user-invocable: true'].join('\n')
    )

    const skills = discoverSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'summarise',
      description: 'Summarise the workspace'
    })
  })

  it('includes argument-hint when provided', async () => {
    await writeSkill(
      'review',
      [
        'name: review',
        'description: Review the diff',
        'user-invocable: true',
        'argument-hint: <pr_number>'
      ].join('\n')
    )

    const skills = discoverSkills()
    expect(skills[0]?.argumentHint).toBe('<pr_number>')
  })

  it('skips skills without user-invocable: true', async () => {
    await writeSkill(
      'internal',
      ['name: internal', 'description: Hidden', 'user-invocable: false'].join('\n')
    )

    expect(discoverSkills()).toEqual([])
  })

  it('skips skills missing required fields', async () => {
    await writeSkill('no-name', ['description: Missing name', 'user-invocable: true'].join('\n'))
    await writeSkill('no-desc', ['name: no-desc', 'user-invocable: true'].join('\n'))

    expect(discoverSkills()).toEqual([])
  })

  it('truncates long descriptions to 100 chars', async () => {
    const longDesc = 'x'.repeat(150)
    await writeSkill(
      'long',
      ['name: long', `description: ${longDesc}`, 'user-invocable: true'].join('\n')
    )

    const skills = discoverSkills()
    expect(skills[0]?.description.length).toBe(100)
  })

  it('strips surrounding quotes from frontmatter values', async () => {
    await writeSkill(
      'quoted',
      ['name: "quoted"', "description: 'Has quoted strings'", 'user-invocable: "true"'].join('\n')
    )

    const skills = discoverSkills()
    expect(skills[0]?.name).toBe('quoted')
    expect(skills[0]?.description).toBe('Has quoted strings')
  })

  it('skips entries with no SKILL.md', async () => {
    await mkdir(join(skillsDir(), 'empty'), { recursive: true })
    expect(discoverSkills()).toEqual([])
  })

  it('skips entries with missing or invalid frontmatter', async () => {
    const dir = join(skillsDir(), 'no-frontmatter')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), 'Just body text, no frontmatter\n', 'utf-8')

    expect(discoverSkills()).toEqual([])
  })

  it('skips entries that lstat cannot read', async () => {
    // Create a SKILL.md at the top level so it doesn't look like a skill dir
    await mkdir(skillsDir(), { recursive: true })
    // A path with invalid bytes will not match any readdir; just sanity-check that
    // a regular file in the skills dir (not a directory) does not break discovery.
    await writeFile(join(skillsDir(), 'README.md'), 'not a skill\n', 'utf-8')

    expect(discoverSkills()).toEqual([])
  })

  it('resolves symlinks when scanning skills', async () => {
    const target = await mkdtemp(join(tmpdir(), 'pi-pipe-skill-target-'))
    await writeFile(
      join(target, 'SKILL.md'),
      '---\nname: linked\ndescription: Linked skill\nuser-invocable: true\n---',
      'utf-8'
    )

    await mkdir(skillsDir(), { recursive: true })
    await symlink(target, join(skillsDir(), 'linked'))

    const skills = discoverSkills()
    expect(skills.map((s) => s.name)).toContain('linked')

    await rm(target, { recursive: true, force: true })
  })
})
