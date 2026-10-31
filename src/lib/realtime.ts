import { logger } from './logger';

/**
 * Stand-in for the module 01 Socket.IO helpers (`emit to room`, `disconnectSession`). No Socket.IO server is built yet,
 * so events go to a pluggable sink: logged by default, collected in memory by tests. Module 01's real server replaces it.
 */
export interface RealtimeEvent {
  room: string;
  event: string;
  payload: Record<string, unknown>;
}
export interface RealtimeSink {
  emit(e: RealtimeEvent): void;
  disconnectSession(sessionId: number): void;
}

const defaultSink: RealtimeSink = {
  emit: e => logger.debug({ room: e.room, event: e.event }, 'realtime emit (no socket server)'),
  disconnectSession: sessionId =>
    logger.debug({ sessionId }, 'realtime disconnectSession (no socket server)'),
};
let sink: RealtimeSink = defaultSink;
export const setRealtimeSink = (s: RealtimeSink | undefined): void => {
  sink = s ?? defaultSink;
};

export const emitToUser = (userId: number, event: string, payload: Record<string, unknown>): void =>
  sink.emit({ room: `user:${userId}`, event, payload });
export const disconnectSession = (sessionId: number): void => sink.disconnectSession(sessionId);
