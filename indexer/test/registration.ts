// Register the real event handlers without starting Envio, Postgres or a network connection.
export const handlers = new Map<string, (input: any) => Promise<void>>();
export const indexer = {
  onEvent: ({ contract, event }: { contract: string; event: string }, handler: (input: any) => Promise<void>) => {
    handlers.set(`${contract}.${event}`, handler);
  },
};
