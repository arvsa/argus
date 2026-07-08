import client from "./client";

export interface NodeType {
  id: string;
  tenant_id: string;
  name: string;
  rank: number;
  parent_type_id: string | null;
  created_at: string | null;
}

export interface NodeTypesPublic {
  data: NodeType[];
  count: number;
}

export const getNodeTypes = async () => {
  const res = await client.get<NodeTypesPublic>("/node-types/", { params: { limit: 1000 } });
  return res.data;
};

export const createNodeType = async (data: {
  tenant_id: string;
  name: string;
  rank: number;
  parent_type_id?: string | null;
}) => {
  const res = await client.post<NodeType>("/node-types/", data);
  return res.data;
};

export const renameNodeType = async (id: string, name: string) => {
  const res = await client.put<NodeType>(`/node-types/${id}`, { name });
  return res.data;
};

export const deleteNodeType = async (id: string) => {
  await client.delete(`/node-types/${id}`);
};
