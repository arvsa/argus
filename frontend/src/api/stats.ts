import client from "./client";

export interface Stats {
  total: number;
  up: number;
  down: number;
}

export const getStats = async () => {
  const res = await client.get<Stats>("/stats");
  return res.data;
};
