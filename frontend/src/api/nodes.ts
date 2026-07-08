import client from "./client";

export interface Node {
  id: string;
  name: string;
  node_type_id: string;
  parent_id: string | null;
  path_ids: string[];
  created_at: string | null;
}

export interface NodesPublic {
  data: Node[];
  count: number;
}

export const getNodes = async (params: { parentId: string | null; tenantId?: string }) => {
  const res = await client.get<NodesPublic>("/nodes/", {
    params: {
      parent_id: params.parentId ?? "null",
      tenant_id: params.tenantId,
      limit: 1000,
    },
  });
  return res.data;
};

export const getNode = async (id: string) => {
  const res = await client.get<Node>(`/nodes/${id}`);
  return res.data;
};

export const createNode = async (data: {
  name: string;
  node_type_id: string;
  parent_id: string | null;
}) => {
  const res = await client.post<Node>("/nodes/", data);
  return res.data;
};

export const renameNode = async (id: string, name: string) => {
  const res = await client.put<Node>(`/nodes/${id}`, { name });
  return res.data;
};

export const deleteNode = async (id: string) => {
  await client.delete(`/nodes/${id}`);
};
