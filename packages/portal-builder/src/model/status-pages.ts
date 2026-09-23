/**
 * The HTTP statuses this portal generates a page for, chosen by what a static host can be
 * configured to serve: nginx's `error_page`, Apache's `ErrorDocument`, a CDN's custom error
 * response. Each names a file, and a missing file leaves the visitor the origin's own default -
 * an unstyled page from software they have never heard of, with no link back to the site.
 *
 * The wording is for the person reading it: "502 Bad Gateway" tells a visitor nothing, while "the
 * portal could not reach the service behind it" says it is not their fault. The specification's
 * own name is kept beside it for whoever they forward the screenshot to.
 */
export interface StatusPage {
  code: number;
  /** The specification's name for the status, shown small. */
  reason: string;
  /** What the page says at the top, in the site's own voice. */
  title: string;
  /** One sentence for the reader and for the document's meta description. */
  summary: string;
  /** Whether the visitor's own next action can plausibly fix it. */
  retry: boolean;
}

export const STATUS_PAGES: readonly StatusPage[] = [
  {
    code: 400,
    reason: "Bad Request",
    title: "That address could not be read",
    summary: "The link that brought you here is malformed, so the server could not act on it.",
    retry: false,
  },
  {
    code: 401,
    reason: "Unauthorized",
    title: "You need to sign in first",
    summary: "This page is only available to signed-in users.",
    retry: false,
  },
  {
    code: 403,
    reason: "Forbidden",
    title: "This page is not yours to see",
    summary: "Your account does not have access to this page.",
    retry: false,
  },
  {
    code: 404,
    reason: "Not Found",
    title: "Page not found",
    summary: "The page you asked for does not exist on this site.",
    retry: false,
  },
  {
    code: 405,
    reason: "Method Not Allowed",
    title: "That is not something this address does",
    summary: "The request used a method this address does not accept.",
    retry: false,
  },
  {
    code: 408,
    reason: "Request Timeout",
    title: "The request took too long",
    summary: "The server stopped waiting before your request finished arriving.",
    retry: true,
  },
  {
    code: 410,
    reason: "Gone",
    title: "This page has been removed",
    summary: "The page was deliberately withdrawn and there is no replacement at this address.",
    retry: false,
  },
  {
    code: 413,
    reason: "Content Too Large",
    title: "That was too much to send at once",
    summary: "The request was larger than this service accepts.",
    retry: false,
  },
  {
    code: 429,
    reason: "Too Many Requests",
    title: "Too many requests, too quickly",
    summary: "This service is rate-limited and has asked you to wait before trying again.",
    retry: true,
  },
  {
    code: 500,
    reason: "Internal Server Error",
    title: "Something went wrong at our end",
    summary: "The server hit an error handling this request. Nothing you did caused it.",
    retry: true,
  },
  {
    code: 502,
    reason: "Bad Gateway",
    title: "The portal could not reach the service behind it",
    summary: "A service this page depends on returned something the portal could not use.",
    retry: true,
  },
  {
    code: 503,
    reason: "Service Unavailable",
    title: "The service is temporarily unavailable",
    summary: "The service is down for maintenance or is overloaded. It should be back shortly.",
    retry: true,
  },
  {
    code: 504,
    reason: "Gateway Timeout",
    title: "The service did not answer in time",
    summary: "A service this page depends on took too long to respond.",
    retry: true,
  },
];

/** Look up a status page by its code, for a template that has only the number. */
export function statusPage(code: number): StatusPage | undefined {
  return STATUS_PAGES.find((page) => page.code === code);
}
