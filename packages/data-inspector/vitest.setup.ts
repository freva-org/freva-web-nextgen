/**
 * Test setup.
 *
 * When `disableIframePageLoading` is enabled, happy-dom reports the disabled
 * load by writing a `NotSupportedError` ("Failed to load iframe page …") to the
 * console and dispatching an `error` event on the iframe. That is an artifact
 * of the test environment (real browsers load iframes fine) and would
 * otherwise flood the output. happy-dom forwards through a VirtualConsole that
 * captured the original sink before this setup runs, so we filter at the
 * stream level - dropping only this specific message.
 */

const MARKER = "Failed to load iframe page";

for (const stream of [process.stderr, process.stdout]) {
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string" && chunk.includes(MARKER)) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (original as any)(chunk, ...rest);
  }) as typeof stream.write;
}
