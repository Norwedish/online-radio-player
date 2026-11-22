import { type CommandType, type WorkerEventType } from "@radio/shared";
export type CommandHandler = (type: CommandType, payload: unknown) => Promise<unknown> | unknown;
export declare class ProtocolServer {
  private readonly handler;
  private readonly opts;
  private server;
  private readonly clients;
  private heartbeat;
  /** Commands are serialized so conflicting operations never interleave (M6.3). */
  private chain;
  constructor(
    handler: CommandHandler,
    opts?: {
      token?: string;
      log?: (m: string) => void;
      heartbeatMs?: number;
      hello?: () => unknown;
    },
  );
  listen(
    endpoint:
      | {
          socket: string;
        }
      | {
          port: number;
          host?: string;
        },
  ): Promise<void>;
  address(): string;
  get port(): number;
  private onConnection;
  broadcast(event: WorkerEventType, payload: unknown): void;
  get clientCount(): number;
  close(): Promise<void>;
}
//# sourceMappingURL=server.d.ts.map
