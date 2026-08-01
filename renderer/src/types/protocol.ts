import { METHODS, EVENTS, PROTOCOL_VERSION, isProtocolCompatible } from '@shared/protocol'

export { METHODS, EVENTS, PROTOCOL_VERSION, isProtocolCompatible }

export type MethodName = (typeof METHODS)[keyof typeof METHODS]
export type EventName = (typeof EVENTS)[keyof typeof EVENTS]

export interface RequestMessage {
  type: 'request'
  v?: string
  id: string
  method: MethodName
  params: unknown
}

export interface ResponseMessage {
  type: 'response'
  v?: string
  id: string
  result?: unknown
  error?: string
}

export interface EventMessage {
  type: 'event'
  v?: string
  event: EventName
  data: unknown
}

export type WireMessage = RequestMessage | ResponseMessage | EventMessage
