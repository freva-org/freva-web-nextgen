// A prose block's figure video: loaded only when the figure comes into view, in the page's
// theme, played while it is on screen and paused when it is not. With reduced motion it never
// loads: the still stays. The still is in the page from the start (and without JavaScript), so
// the video only ever replaces a picture of itself once it is actually playing.

const VIDEO_TYPES: Record<string, string> = {
  mp4: 'video/mp4; codecs="avc1.640028"',
  webm: 'video/webm; codecs="vp9"',
};
const extension = (url: string) => /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase() ?? "";

/** What the player needs from the page (injected, so it can be tested without one). */
export interface FigureEnv {
  reducedMotion(): boolean;
  theme(): "light" | "dark";
  /** Calls back with whether the figure is near the viewport; returns the teardown. */
  watchVisibility(figure: HTMLElement, changed: (visible: boolean) => void): () => void;
  /** Calls back when the theme or the motion preference changes; returns the teardown. */
  watchPreferences(changed: () => void): () => void;
}

const browserEnv = (): FigureEnv => {
  const motion =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  return {
    reducedMotion: () => motion?.matches ?? false,
    theme: () =>
      document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
    watchVisibility: (figure, changed) => {
      if (typeof IntersectionObserver !== "function") {
        changed(true);
        return () => undefined;
      }
      const observer = new IntersectionObserver(
        (entries) => changed(entries.some((entry) => entry.isIntersecting)),
        { rootMargin: "120px 0px" },
      );
      observer.observe(figure);
      return () => observer.disconnect();
    },
    watchPreferences: (changed) => {
      const theme = new MutationObserver(changed);
      theme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      motion?.addEventListener("change", changed);
      return () => {
        theme.disconnect();
        motion?.removeEventListener("change", changed);
      };
    },
  };
};

/** One figure's controller; returns its teardown. */
export function mountFigure(figure: HTMLElement, env: FigureEnv = browserEnv()): () => void {
  const video = figure.querySelector<HTMLVideoElement>("[data-portal-figure-video]");
  if (!video) return () => undefined;
  let visible = false;
  // The theme's clip in the first format this browser can play (an open-source Chromium has no
  // H.264, so an MP4 alone would never play there).
  const source = () => {
    const urls = (figure.dataset[env.theme() === "dark" ? "videoDark" : "videoLight"] ?? "")
      .split(/\s+/)
      .filter(Boolean);
    return urls.find((url) => video.canPlayType(VIDEO_TYPES[extension(url)] ?? "") !== "") ?? "";
  };

  const stop = () => {
    video.pause();
    delete figure.dataset.playing;
  };
  const update = () => {
    if (!visible || env.reducedMotion()) {
      stop();
      return;
    }
    const wanted = source();
    if (!wanted) {
      // Nothing this browser plays for this theme: the still, never another theme's clip.
      stop();
      video.removeAttribute("src");
      return;
    }
    if (video.getAttribute("src") !== wanted) {
      // Another theme's clip: the same scene, so it carries on where the other one was.
      const at = video.currentTime || 0;
      delete figure.dataset.playing;
      video.setAttribute("src", wanted);
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (at && Number.isFinite(video.duration)) video.currentTime = at % video.duration;
        },
        { once: true },
      );
    }
    // Muted and inline: allowed to start without a gesture. A refusal leaves the still.
    void video.play().catch(() => undefined);
  };

  const onPlaying = () => {
    // Only the clip this theme asked for may show itself.
    if (video.getAttribute("src") === source() && visible && !env.reducedMotion()) {
      figure.dataset.playing = "";
    }
  };
  video.addEventListener("playing", onPlaying);
  const unwatchVisibility = env.watchVisibility(figure, (now) => {
    visible = now;
    update();
  });
  const unwatchPreferences = env.watchPreferences(update);

  return () => {
    unwatchVisibility();
    unwatchPreferences();
    video.removeEventListener("playing", onPlaying);
    stop();
  };
}

export function mountProseFigures(root: ParentNode = document): void {
  root
    .querySelectorAll<HTMLElement>("[data-portal-figure][data-video-light]")
    .forEach((figure) => void mountFigure(figure));
}
