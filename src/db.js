import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export const DEFAULT_HIDE = { surname: true, address: true, email: true, phone: true, linkedin: true, github: true, social: true, sites: true, photos: true, latest: true };

/** Settings row of ONE user (every HR has their own), created on first use. */
export async function getSettings(userId) {
  const row = await prisma.setting.findUnique({ where: { user_id: userId } });
  return row ?? prisma.setting.upsert({ where: { user_id: userId }, update: {}, create: { user_id: userId, hide: DEFAULT_HIDE } });
}
