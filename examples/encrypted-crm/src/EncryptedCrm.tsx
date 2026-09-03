import {
  EncryptedSheetDatabase,
  EncryptedSheetDatabaseError,
  type EncryptedSheetDatabaseStorage,
  type EncryptedSheetRecord,
} from "@zerosheet/sdk";
import { googleA1Range } from "@zerosheet/sheet-core";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

interface Customer extends EncryptedSheetRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly status: string;
  readonly spend: number;
}

export interface EncryptedCrmProps {
  /** The reviewed GoogleWorkspaceStorage instance from the host application. */
  readonly storage: EncryptedSheetDatabaseStorage;
  readonly workbookId: string;
  readonly spreadsheetId: string;
  readonly sheetId: string;
  readonly sheetTitle: string;
  readonly keyVersion: number;
  /** Recovered by the host in-browser; never a server secret or raw byte array. */
  readonly workbookKey: CryptoKey;
}

type ViewState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly customers: readonly Customer[];
      readonly rawRows: readonly (readonly unknown[])[];
    }
  | { readonly status: "error"; readonly code: string };

/**
 * A deliberately small React CRM proves the two product faces share one data
 * format: people see decrypted records here while the adjacent panel renders
 * the exact ciphertext/public metadata returned by the underlying Sheet.
 */
export function EncryptedCrm(props: EncryptedCrmProps) {
  const [view, setView] = useState<ViewState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [spend, setSpend] = useState("0");

  const customers = useMemo(
    () =>
      new EncryptedSheetDatabase({
        storage: props.storage,
        spreadsheetId: props.spreadsheetId,
        workbookId: props.workbookId,
        keyVersion: props.keyVersion,
        key: props.workbookKey,
        collections: {
          customers: {
            sheetId: props.sheetId,
            sheetTitle: props.sheetTitle,
            idPrefix: "cus_",
            maxRecords: 1_000,
            fields: [
              { name: "name" },
              { name: "email" },
              // This demo exposes status intentionally so a simple Google-side
              // workflow can route rows without learning names/email/spend.
              { name: "status", protection: "public" },
              { name: "spend" },
            ],
          },
        },
      }).collection<Customer>("customers"),
    [props],
  );

  const refresh = useCallback(async () => {
    setView({ status: "loading" });
    try {
      const normalizedQuery = query.trim().toLocaleLowerCase();
      const [page, raw] = await Promise.all([
        normalizedQuery
          ? customers.filter(
              (customer) =>
                customer.name.toLocaleLowerCase().includes(normalizedQuery) ||
                customer.email.toLocaleLowerCase().includes(normalizedQuery),
              { limit: 25 },
            )
          : customers.page({ limit: 25 }),
        // This read is presentation-only. The SDK is still the sole CRUD path;
        // rendering raw rows beside plaintext makes the storage claim testable.
        props.storage.batchReadValues(props.spreadsheetId, [
          googleA1Range(props.sheetTitle, {
            startRow: 0,
            endRow: 25,
            startColumn: 0,
            endColumn: 4,
          }),
        ]),
      ]);
      setView({
        status: "ready",
        customers: page.items,
        rawRows: raw[0]?.values ?? [],
      });
    } catch (error) {
      setView({
        status: "error",
        code:
          error instanceof EncryptedSheetDatabaseError
            ? error.code
            : "SDK_STORAGE_UNAVAILABLE",
      });
    }
  }, [customers, props.sheetTitle, props.spreadsheetId, props.storage, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Event handlers cannot let a rejected storage/crypto promise become an
   * unhandled browser rejection. Keep the same stable SDK error categories as
   * initial loading so the example demonstrates a safe recoverable UI state.
   */
  async function mutate(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      await refresh();
      return true;
    } catch (error) {
      setView({
        status: "error",
        code:
          error instanceof EncryptedSheetDatabaseError
            ? error.code
            : "SDK_STORAGE_UNAVAILABLE",
      });
      return false;
    }
  }

  async function addCustomer(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const numericSpend = Number(spend);
    if (!Number.isFinite(numericSpend)) return;
    const inserted = await mutate(() =>
      customers.insert({
        name: name.trim(),
        email: email.trim(),
        status: "lead",
        spend: numericSpend,
      }),
    );
    if (inserted) {
      setName("");
      setEmail("");
      setSpend("0");
    }
  }

  async function markCustomer(id: string): Promise<void> {
    await mutate(() => customers.update(id, { status: "customer" }));
  }

  async function removeCustomer(id: string): Promise<void> {
    await mutate(() => customers.delete(id));
  }

  return (
    <main className="crm-shell">
      <header>
        <p className="eyebrow">ZeroSheet encrypted CRM example</p>
        <h1>Plaintext here. Ciphertext in your Google Sheet.</h1>
        <a
          href={`https://docs.google.com/spreadsheets/d/${encodeURIComponent(props.spreadsheetId)}/edit`}
          rel="noreferrer"
          target="_blank"
        >
          Open the underlying Google Sheet
        </a>
      </header>

      <form onSubmit={(event) => void addCustomer(event)}>
        <input
          aria-label="Customer name"
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
        <input
          aria-label="Customer email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
        <input
          aria-label="Customer spend"
          onChange={(event) => setSpend(event.target.value)}
          required
          type="number"
          value={spend}
        />
        <button type="submit">Add encrypted customer</button>
      </form>

      <label>
        Search locally after decryption
        <input
          onChange={(event) => setQuery(event.target.value)}
          value={query}
        />
      </label>

      {view.status === "loading" && <p>Decrypting records in this browser…</p>}
      {view.status === "error" && (
        <p role="alert">The CRM stopped safely: {view.code}</p>
      )}
      {view.status === "ready" && (
        <div className="comparison-grid">
          <section>
            <h2>Application plaintext</h2>
            <table>
              <thead>
                <tr>
                  <th>ID (public)</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Status (public)</th>
                  <th>Spend</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {view.customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>{customer.id}</td>
                    <td>{customer.name}</td>
                    <td>{customer.email}</td>
                    <td>{customer.status}</td>
                    <td>{customer.spend}</td>
                    <td>
                      <button
                        onClick={() => void markCustomer(customer.id)}
                        type="button"
                      >
                        Mark customer
                      </button>
                      <button
                        onClick={() => void removeCustomer(customer.id)}
                        type="button"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h2>Underlying Sheet values</h2>
            <p>
              `_id`, headers, and status are visible metadata. Other cells are
              authenticated `zs1` ciphertext.
            </p>
            <pre>{JSON.stringify(view.rawRows, null, 2)}</pre>
          </section>
        </div>
      )}
    </main>
  );
}
