import type { Env } from "../types";
import type { ROLE } from "./const";

export type Member = { role: (typeof ROLE)[keyof typeof ROLE]; workspaceId: string };

export type Vars = {
  reqId: string;
  userId: string;
  member: Member;
  body: unknown;
};

export type HonoEnv = { Bindings: Env; Variables: Vars };
