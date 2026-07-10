import { APIRequestContext, APIResponse } from '@playwright/test';

// Thin resource-oriented client over APIRequestContext.
// One class per API resource keeps specs readable and endpoint paths in ONE place.
// ADAPT-ME: rename/extend per the real OpenAPI surface (e.g. OrdersClient, UsersClient).

export class ResourceClient {
  constructor(
    private readonly ctx: APIRequestContext,
    private readonly basePath: string, // e.g. '/orders'
  ) {}

  list(params?: Record<string, string | number>): Promise<APIResponse> {
    return this.ctx.get(this.basePath, { params });
  }

  getById(id: string | number): Promise<APIResponse> {
    return this.ctx.get(`${this.basePath}/${id}`);
  }

  create(data: unknown): Promise<APIResponse> {
    return this.ctx.post(this.basePath, { data });
  }

  update(id: string | number, data: unknown): Promise<APIResponse> {
    return this.ctx.put(`${this.basePath}/${id}`, { data });
  }

  delete(id: string | number): Promise<APIResponse> {
    return this.ctx.delete(`${this.basePath}/${id}`);
  }
}
