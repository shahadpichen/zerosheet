import {
  EncryptedSheetDatabase,
  type EncryptedSheetDatabaseOptions,
  type EncryptedSheetRecord,
  type PaginationOptions,
} from "@zerosheet/sdk";

export interface Customer extends EncryptedSheetRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly stage: string;
  readonly annualValue: number;
}

/**
 * Business code sees a familiar repository while @zerosheet/sdk owns row IDs,
 * local encryption, conflict checks, and Google batching. The bootstrap must
 * provide an authorized Google storage adapter and an already recovered key.
 */
export function createCustomerRepository(
  options: Omit<EncryptedSheetDatabaseOptions, "collections">,
) {
  const customers = new EncryptedSheetDatabase({
    ...options,
    collections: {
      customers: {
        sheetId: "0",
        sheetTitle: "Customers",
        idPrefix: "cus_",
        maxRecords: 2_000,
        fields: [
          { name: "name" },
          { name: "email" },
          { name: "stage", protection: "public" },
          { name: "annualValue" },
        ],
      },
    },
  }).collection<Customer>("customers");

  return {
    insert: (customer: Omit<Customer, "id">) => customers.insert(customer),
    get: (id: string) => customers.get(id),
    update: (id: string, patch: Partial<Omit<Customer, "id">>) =>
      customers.update(id, patch),
    delete: (id: string) => customers.delete(id),
    all: () => customers.all(),
    page: (pagination?: PaginationOptions) => customers.page(pagination),
    qualifiedLeads: (pagination?: PaginationOptions) =>
      customers.filter(
        (customer) =>
          customer.stage === "qualified" && customer.annualValue >= 10_000,
        pagination,
      ),
  };
}
