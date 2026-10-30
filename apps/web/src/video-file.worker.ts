// Writes the session video into the site's private storage on the device (not the Photos library, not visible in
// Files), so a long recording never has to fit in memory. Only a worker may write there synchronously, and that works
// on every Safari that can encode the video.
type Message = { open: string } | { data: Uint8Array<ArrayBuffer>; position: number } | { close: true };

// The worker-only handle, which the page's type library does not describe.
type SyncHandle = { write(data: BufferSource, options: { at: number }): number; truncate(size: number): void; flush(): void; close(): void };
let handle: SyncHandle | undefined;
self.onmessage = async (event: MessageEvent<Message>) => {
  const message = event.data;
  try {
    if ('open' in message) {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle(message.open, { create: true });
      handle = await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
      handle.truncate(0);
      self.postMessage({ ready: true });
    } else if ('data' in message) {
      handle!.write(message.data, { at: message.position });
    } else {
      handle?.flush(); handle?.close(); handle = undefined;
      self.postMessage({ closed: true });
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'could not write the video' });
  }
};
