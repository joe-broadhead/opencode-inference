import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin, Skill } from "@opencode/plugin"
import { InferenceError } from "../domain/errors.js"
import type { Module } from "../domain/ids.js"

// The shipped skills: `skills/<id>/SKILL.md` in the package, each tied to the module whose tool it teaches. A skill is
// registered only while its module is on. A missing or malformed file is optional content: it is skipped and reported
// as a status problem, and setup carries on.

type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]

/** The hand-written skills and the module each one teaches. */
export const SKILLS = { "inference-extract": "extractions", "inference-decide": "decisions" } as const satisfies Record<string, Module>
export type SkillID = keyof typeof SKILLS
export const SKILL_IDS = Object.keys(SKILLS) as SkillID[]

export interface LoadedSkill {
  readonly id: SkillID
  readonly module: Module
  readonly info: Skill.Info
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

/** Parses one SKILL.md: front matter with exactly `name` (the id) and a `description`, then a non-empty body. */
export function parseSkill(id: SkillID, text: string, path: string): LoadedSkill | undefined {
  const match = FRONT_MATTER.exec(text)
  if (!match) return undefined
  const fields = new Map((match[1] ?? "").split(/\r?\n/).map((line) => /^(\w+):\s*(.+?)\s*$/.exec(line)).filter((found) => found !== null).map((found) => [found[1]!, found[2]!] as const))
  const body = match[2]!.trim()
  if (fields.get("name") !== id || !fields.get("description") || body.length === 0 || text.length > 64 * 1024) return undefined
  return { id, module: SKILLS[id], info: { id, name: id, description: fields.get("description")!, path, content: body, autoinvoke: true } as Skill.Info }
}

/** Reads the shipped skills. Each one that is missing or malformed is skipped and named in `problems`. */
export async function loadSkills(packageRoot: string): Promise<{ skills: LoadedSkill[]; problems: string[] }> {
  const skills: LoadedSkill[] = []
  const problems: string[] = []
  for (const id of SKILL_IDS) {
    const path = join(packageRoot, "skills", id, "SKILL.md")
    const parsed = await readFile(path, "utf8").then(
      (text) => parseSkill(id, text, path),
      () => undefined,
    )
    if (parsed) skills.push(parsed)
    else problems.push(new InferenceError("SKILLS_INVALID", `The skill ${id} is missing or malformed, so it was skipped.`).message)
  }
  return { skills, problems }
}

/** Registers the skills of the modules that are on. */
export function skillTransform(skills: readonly LoadedSkill[], enabled: (module: Module) => boolean) {
  return (editor: SkillEditor) => {
    for (const skill of skills) if (enabled(skill.module)) editor.add(skill.info)
  }
}
