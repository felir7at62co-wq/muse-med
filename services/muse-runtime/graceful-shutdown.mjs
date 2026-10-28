/** Close broker admission before waiting for the accepted Docker operations. */
export function createBrokerShutdown({ server, operations, stopAccepting }) {
  let closing;
  return function close() {
    if (closing) return closing;
    stopAccepting();
    const connectionsClosed = new Promise((resolve, reject) => {
      server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    });
    // Capture both the ensure promises and the serialized tail. The latter also
    // owns accepted /stop requests, which are absent from the ensure map.
    const accepted = Array.from(operations());
    closing = Promise.all([connectionsClosed, Promise.allSettled(accepted)]).then(() => {});
    return closing;
  };
}
