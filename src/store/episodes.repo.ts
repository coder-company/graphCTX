import { type Clock, systemClock } from "../core/clock.js";
import { eventId } from "../core/ids.js";
import type { Episode, NewEpisode } from "../core/types.js";
import type { DB } from "./db.js";

interface EpisodeRow {
  event_id: string;
  session_id: string;
  workspace_id: string | null;
  event_type: string;
  payload_json: string;
  git_head: string | null;
  git_branch: string | null;
  created_at: string;
}

function rowToEpisode(r: EpisodeRow): Episode {
  return {
    event_id: r.event_id,
    session_id: r.session_id,
    workspace_id: r.workspace_id ?? undefined,
    event_type: r.event_type as Episode["event_type"],
    payload: JSON.parse(r.payload_json),
    git_head: r.git_head ?? undefined,
    git_branch: r.git_branch ?? undefined,
    created_at: r.created_at,
  };
}

export class EpisodesRepo {
  private readonly db: DB;
  private readonly clock: Clock;

  constructor(db: DB, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  append(input: NewEpisode): Episode {
    const id = eventId();
    const created = this.clock.iso();
    this.db
      .prepare(
        `INSERT INTO episodes (
          event_id, session_id, workspace_id, event_type, payload_json, git_head, git_branch, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.session_id,
        input.workspace_id ?? null,
        input.event_type,
        JSON.stringify(input.payload),
        input.git_head ?? null,
        input.git_branch ?? null,
        created,
      );
    return {
      event_id: id,
      session_id: input.session_id,
      workspace_id: input.workspace_id,
      event_type: input.event_type,
      payload: input.payload,
      git_head: input.git_head,
      git_branch: input.git_branch,
      created_at: created,
    };
  }

  bySession(sessionId: string): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as EpisodeRow[];
    return rows.map(rowToEpisode);
  }

  tail(sessionId: string, n: number): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionId, n) as EpisodeRow[];
    return rows.reverse().map(rowToEpisode);
  }
}
