import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactKind, NewFact } from "../../core/types.js";
import { existingWorkspacePath } from "../../security/workspace-path.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

const DOCKERFILES = ["Dockerfile", "Dockerfile.dev", "docker/Dockerfile"];
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export const dockerExtractor: Extractor = {
  id: "docker",
  extract(ctx: ExtractContext): NewFact[] {
    const facts: NewFact[] = [];
    for (const file of DOCKERFILES) {
      if (!existingWorkspacePath(ctx.workspaceDir, file)) continue;
      facts.push(...extractDockerfile(ctx, file));
    }
    for (const file of COMPOSE_FILES) {
      if (!existingWorkspacePath(ctx.workspaceDir, file)) continue;
      facts.push(...extractCompose(ctx, file));
    }
    return facts;
  },
};

function extractDockerfile(ctx: ExtractContext, file: string): NewFact[] {
  let text: string;
  try {
    text = readFileSync(join(ctx.workspaceDir, file), "utf8");
  } catch {
    return [];
  }

  const facts: NewFact[] = [];
  for (const line of text.split("\n")) {
    const stripped = stripDockerComment(line).trim();
    if (!stripped) continue;

    const from = parseFromInstruction(stripped);
    if (from) {
      const { image, stage } = from;
      facts.push(
        dockerFact(ctx, file, {
          subject: file,
          predicate: "container_base_image",
          object: image,
          factKind: "semantic",
          tags: ["docker", "container", "image", "config_file"],
          rawQuote: stripped,
        }),
      );
      if (stage) {
        facts.push(
          dockerFact(ctx, file, {
            subject: `${file} stage ${stage}`,
            predicate: "container_stage_base",
            object: image,
            factKind: "semantic",
            tags: ["docker", "container", "stage", "config_file"],
            rawQuote: stripped,
          }),
        );
      }
      continue;
    }

    const expose = /^EXPOSE\s+(.+)$/i.exec(stripped);
    if (expose) {
      for (const port of expose[1]!.split(/\s+/).filter(Boolean).slice(0, 20)) {
        facts.push(
          dockerFact(ctx, file, {
            subject: file,
            predicate: "container_exposed_port",
            object: port,
            factKind: "semantic",
            tags: ["docker", "container", "port", "config_file"],
            rawQuote: stripped,
          }),
        );
      }
      continue;
    }

    const workdir = /^WORKDIR\s+(.+)$/i.exec(stripped);
    if (workdir) {
      facts.push(
        dockerFact(ctx, file, {
          subject: file,
          predicate: "container_workdir",
          object: workdir[1]!.trim(),
          factKind: "semantic",
          tags: ["docker", "container", "paths", "config_file"],
          rawQuote: stripped,
        }),
      );
      continue;
    }

    const user = /^USER\s+(.+)$/i.exec(stripped);
    if (user) {
      facts.push(
        dockerFact(ctx, file, {
          subject: file,
          predicate: "container_user",
          object: user[1]!.trim(),
          factKind: "constraint",
          tags: ["docker", "container", "security", "config_file"],
          rawQuote: stripped,
        }),
      );
    }
  }

  return facts.slice(0, 60);
}

function extractCompose(ctx: ExtractContext, file: string): NewFact[] {
  let text: string;
  try {
    text = readFileSync(join(ctx.workspaceDir, file), "utf8");
  } catch {
    return [];
  }

  const facts: NewFact[] = [];
  for (const service of parseComposeServices(text)) {
    facts.push(
      dockerFact(ctx, file, {
        subject: `compose service ${service.name}`,
        predicate: "compose_service",
        object: service.name,
        factKind: "semantic",
        tags: ["docker", "compose", "service", "config_file"],
        rawQuote: `${file} services.${service.name}`,
      }),
    );
    if (service.image) {
      facts.push(
        dockerFact(ctx, file, {
          subject: `compose service ${service.name}`,
          predicate: "compose_image",
          object: service.image,
          factKind: "semantic",
          tags: ["docker", "compose", "image", "config_file"],
          rawQuote: `${file} services.${service.name}.image: ${service.image}`,
        }),
      );
    }
    if (service.build) {
      facts.push(
        dockerFact(ctx, file, {
          subject: `compose service ${service.name}`,
          predicate: "compose_build_context",
          object: service.build,
          factKind: "semantic",
          tags: ["docker", "compose", "build", "config_file"],
          rawQuote: `${file} services.${service.name}.build: ${service.build}`,
        }),
      );
    }
    for (const port of service.ports.slice(0, 20)) {
      facts.push(
        dockerFact(ctx, file, {
          subject: `compose service ${service.name}`,
          predicate: "compose_port",
          object: port,
          factKind: "semantic",
          tags: ["docker", "compose", "port", "config_file"],
          rawQuote: `${file} services.${service.name}.ports: ${port}`,
        }),
      );
    }
  }
  return facts.slice(0, 80);
}

interface ComposeService {
  name: string;
  image?: string;
  build?: string;
  ports: string[];
}

function parseComposeServices(text: string): ComposeService[] {
  const lines = text.split("\n");
  const services: ComposeService[] = [];
  let servicesIndent: number | undefined;
  let current: ComposeService | undefined;
  let currentIndent = -1;
  let inPorts = false;
  let portsIndent = -1;

  for (const raw of lines) {
    const line = stripYamlComment(raw);
    if (!line.trim()) continue;
    const indent = countIndent(line);
    const trimmed = line.trim();

    if (servicesIndent === undefined) {
      if (/^services:\s*$/.test(trimmed)) servicesIndent = indent;
      continue;
    }
    if (indent <= servicesIndent) break;

    const service = /^([A-Za-z0-9_.-]+):\s*$/.exec(trimmed);
    if (service && indent === servicesIndent + 2) {
      current = { name: service[1] as string, ports: [] };
      services.push(current);
      currentIndent = indent;
      inPorts = false;
      continue;
    }
    if (!current || indent <= currentIndent) continue;

    if (/^ports:\s*$/.test(trimmed)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (inPorts && indent > portsIndent) {
      const port = /^-\s*["']?([^"']+)["']?\s*$/.exec(trimmed);
      if (port) current.ports.push(port[1]!.trim());
      continue;
    }
    inPorts = false;

    const image = /^image:\s*["']?([^"']+)["']?\s*$/.exec(trimmed);
    if (image) {
      current.image = image[1]!.trim();
      continue;
    }

    const build = /^build:\s*["']?([^"']+)["']?\s*$/.exec(trimmed);
    if (build) {
      current.build = build[1]!.trim();
    }
  }

  return services.slice(0, 30);
}

function parseFromInstruction(line: string): { image: string; stage?: string } | undefined {
  const parts = line.split(/\s+/);
  if ((parts[0] ?? "").toUpperCase() !== "FROM") return undefined;

  let image: string | undefined;
  let stage: string | undefined;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] as string;
    if (!image && part.startsWith("--")) continue;
    if (!image) {
      image = part;
      continue;
    }
    if (part.toUpperCase() === "AS" && parts[i + 1]) {
      stage = parts[i + 1];
      break;
    }
  }
  return image ? { image, stage } : undefined;
}

function dockerFact(
  ctx: ExtractContext,
  file: string,
  options: {
    subject: string;
    predicate: string;
    object: unknown;
    factKind: FactKind;
    tags: string[];
    rawQuote: string;
  },
): NewFact {
  return structuredFact({
    subject: options.subject,
    predicate: options.predicate,
    object: options.object,
    fact_kind: options.factKind,
    temporal_kind: "static",
    scope: ctx.scope,
    tags: options.tags,
    rawQuote: options.rawQuote,
    git: {
      repo_id: ctx.repoId,
      branch: ctx.branch,
      valid_from_commit: ctx.head,
      introduced_by_commit: ctx.head,
      path_globs: [file],
    },
  });
}

function stripDockerComment(line: string): string {
  const hash = line.indexOf("#");
  return hash === -1 ? line : line.slice(0, hash);
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function countIndent(line: string): number {
  return line.search(/\S/);
}
