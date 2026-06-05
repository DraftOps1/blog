import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const changelog = defineCollection({
  loader: glob({ base: "./src/content/changelog", pattern: "**/*.md" }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    week: z.string(),
    focus: z.string(),
    tags: z.array(z.string()).default([]),
    status: z.string().default("in progress"),
    next: z.string().optional(),
  }),
});

const notes = defineCollection({
  loader: glob({ base: "./src/content/notes", pattern: "**/*.md" }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
  }),
});

const adr = defineCollection({
  loader: glob({ base: "./src/content/adr", pattern: "**/*.md" }),
  schema: z.object({
    decisionId: z.string(),
    title: z.string(),
    date: z.coerce.date(),
    status: z.string(),
    area: z.string(),
    tags: z.array(z.string()).default([]),
  }),
});

const about = defineCollection({
  loader: glob({ base: "./src/content/about", pattern: "**/*.md" }),
  schema: z.object({
    title: z.string(),
    tags: z.array(z.string()).default([]),
    status: z.string().optional(),
    scope: z.string().optional(),
  }),
});

export const collections = { changelog, notes, adr, about };
