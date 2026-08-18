export class CompanionApiError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "CompanionApiError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}
