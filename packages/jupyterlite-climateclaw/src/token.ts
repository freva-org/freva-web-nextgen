// `IFrevaAuth`: the Freva sign-in, shared with other extensions (the data panel uses it for
// protected stores).
//
// Lumino matches services by token OBJECT. So that neither extension has to install the other,
// both obtain the same object from one global slot keyed by `Symbol.for`; whichever loads first
// creates it. The interface is structural and kept identical in
// `@freva-org/jupyterlite-freva-data`.

import { Token } from "@lumino/coreutils";
import type { ISignal } from "@lumino/signaling";

export interface IFrevaAuth {
  /** The Freva host's origin. */
  readonly host: string;
  readonly signedIn: boolean;
  readonly username: string | null;
  /** Emits on sign-in, sign-out and username changes. */
  readonly changed: ISignal<IFrevaAuth, void>;
  /** fetch with the Freva bearer, for the Freva host only. Rejects when not signed in. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** The current access token, for libraries that take a header provider; null when signed out. */
  accessToken(): Promise<string | null>;
  /** Start a login. Call synchronously from a click: it opens a popup. */
  login(): void;
  logout(): Promise<void>;
}

const SLOT = Symbol.for("@freva-org/jupyterlite:IFrevaAuth");

function sharedToken(): Token<IFrevaAuth> {
  const holder = globalThis as unknown as Record<symbol, Token<IFrevaAuth> | undefined>;
  let token = holder[SLOT];
  if (!token) {
    token = new Token<IFrevaAuth>(
      "@freva-org/jupyterlite:IFrevaAuth",
      "The Freva sign-in (popup login; the token never leaves this tab).",
    );
    holder[SLOT] = token;
  }
  return token;
}

export const IFrevaAuth = sharedToken();
