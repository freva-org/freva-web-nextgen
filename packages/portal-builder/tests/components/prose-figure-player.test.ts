// The figure's player: the theme's clip in a playable format, only while on screen and with
// motion allowed; and never another theme's clip over this theme's still.
import { describe, expect, it } from "vitest";

import { mountFigure, type FigureEnv } from "../../client/components/prose-figure.js";

function fakeVideo(playable: string[]) {
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Array<() => void>>();
  return {
    attrs,
    playing: false,
    currentTime: 0,
    duration: 12,
    canPlayType: (type: string) => (playable.some((p) => type.startsWith(p)) ? "probably" : ""),
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
    addEventListener(name: string, listener: () => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
    removeEventListener(name: string, listener: () => void) {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((l) => l !== listener),
      );
    },
    emit(name: string) {
      for (const listener of listeners.get(name) ?? []) listener();
    },
    play() {
      this.playing = true;
      return Promise.resolve();
    },
    pause() {
      this.playing = false;
    },
  };
}

function setup(light: string, dark: string, playable: string[]) {
  const video = fakeVideo(playable);
  const figure = {
    dataset: { videoLight: light, videoDark: dark } as Record<string, string | undefined>,
    querySelector: () => video,
  } as unknown as HTMLElement;
  let theme: "light" | "dark" = "light";
  let reduced = false;
  let visible: (v: boolean) => void = () => undefined;
  let preferences: () => void = () => undefined;
  const env: FigureEnv = {
    reducedMotion: () => reduced,
    theme: () => theme,
    watchVisibility: (_figure, changed) => {
      visible = changed;
      return () => undefined;
    },
    watchPreferences: (changed) => {
      preferences = changed;
      return () => undefined;
    },
  };
  mountFigure(figure, env);
  return {
    video,
    figure,
    show: (v: boolean) => visible(v),
    setTheme: (t: "light" | "dark") => {
      theme = t;
      preferences();
    },
    setReduced: (r: boolean) => {
      reduced = r;
      preferences();
    },
  };
}

describe("the figure's player", () => {
  it("loads nothing until the figure is in view, then the first playable format", () => {
    const f = setup("/l.mp4 /l.webm", "/d.mp4 /d.webm", ["video/webm"]);
    expect(f.video.attrs.get("src")).toBeUndefined();
    f.show(true);
    expect(f.video.attrs.get("src")).toBe("/l.webm");
    expect(f.video.playing).toBe(true);
    f.video.emit("playing");
    expect(f.figure.dataset.playing).toBe("");
    f.show(false);
    expect(f.video.playing).toBe(false);
    expect(f.figure.dataset.playing).toBeUndefined();
  });

  it("follows the theme, and stops when the new theme has nothing playable", () => {
    const f = setup("/l.webm", "/d.mp4", ["video/webm"]);
    f.show(true);
    f.video.emit("playing");
    expect(f.figure.dataset.playing).toBe("");
    // Dark has only an MP4, which this browser cannot play: the dark still, not the light clip.
    f.setTheme("dark");
    expect(f.video.playing).toBe(false);
    expect(f.figure.dataset.playing).toBeUndefined();
    expect(f.video.attrs.get("src")).toBeUndefined();
    // A late `playing` of the old clip does not show it again.
    f.video.emit("playing");
    expect(f.figure.dataset.playing).toBeUndefined();
    f.setTheme("light");
    expect(f.video.attrs.get("src")).toBe("/l.webm");
    expect(f.video.playing).toBe(true);
  });

  it("with reduced motion: stops, and starts nothing", () => {
    const f = setup("/l.webm", "/d.webm", ["video/webm"]);
    f.show(true);
    f.video.emit("playing");
    f.setReduced(true);
    expect(f.video.playing).toBe(false);
    expect(f.figure.dataset.playing).toBeUndefined();
  });
});
