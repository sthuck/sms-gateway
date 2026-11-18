export interface IdGenerator {
  uuid(): string;
  randomToken(bytes?: number): string;
}
