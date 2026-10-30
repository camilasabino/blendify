export const PUBLICATION_QUOTA = 'PUBLICATION_QUOTA' as const;

export interface PublicationQuotaPort {
  consume(userId: string): Promise<void>;
}
