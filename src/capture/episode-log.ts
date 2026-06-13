import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { Episode, NewEpisode } from "../core/types.js";
import type { EpisodesRepo } from "../store/episodes.repo.js";

// Append-only episode log (SPEC §9): mirrors to both episodes.jsonl (durable,
// greppable) and the episodes table (queryable). O(1) append; never blocks the
// hook path beyond one synchronous insert.
export class EpisodeLog {
  private readonly repo: EpisodesRepo;
  private readonly jsonlPath: string;
  private readonly clock: Clock;

  constructor(repo: EpisodesRepo, jsonlPath: string, clock: Clock = systemClock) {
    this.repo = repo;
    this.jsonlPath = jsonlPath;
    this.clock = clock;
  }

  append(input: NewEpisode): Episode {
    const ep = this.repo.append(input);
    this.appendJsonl(ep);
    return ep;
  }

  private appendJsonl(ep: Episode): void {
    try {
      mkdirSync(dirname(this.jsonlPath), { recursive: true });
      appendFileSync(this.jsonlPath, `${JSON.stringify(ep)}\n`, "utf8");
    } catch {
      // JSONL mirror is best-effort; DB is the source of truth. Never fail the hook (I9).
    }
  }
}
