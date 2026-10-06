import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers";

const authMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import dashboardPage from "@/app/page";
import suppliersPage from "@/app/suppliers/page";
import requestDetailPage from "@/app/requests/[id]/page";
import { createRequest, type NewRequest } from "@/lib/db/repository";
import { runSourcingPipeline } from "@/lib/pipeline";

setupTestDb();

const SESSION = {
  user: {
    id: "user_test",
    name: "Test User",
    email: "test.user@procura.co.za",
    role: "procurement_lead",
  },
};

const REQUEST: NewRequest = {
  title: "Task chairs for the studio",
  rawDescription: "We need 10 task chairs for the studio, black mesh.",
  requesterName: "Test User",
  requesterEmail: "test.user@procura.co.za",
  requesterDepartment: "Design",
  unit: "chair",
  quantity: 10,
  currency: "ZAR",
  budgetAmount: null,
  neededBy: null,
  urgency: "normal",
};

/** Every page guard answers with a redirect to the login screen. */
async function expectLogin(promise: Promise<unknown>, next: string) {
  try {
    await promise;
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/login");
    expect(digest).toContain(`next=${encodeURIComponent(next)}`);
    return;
  }
  throw new Error("expected the page to redirect anonymous visitors to /login");
}

beforeEach(() => {
  authMock.mockResolvedValue(null);
});

describe("page session guards", () => {
  it("sends anonymous visitors away from the dashboard", async () => {
    await expectLogin(dashboardPage(), "/");
  });

  it("sends anonymous visitors away from the supplier panel", async () => {
    await expectLogin(suppliersPage(), "/suppliers");
  });

  it("sends anonymous visitors to login before revealing whether a request exists", async () => {
    await expectLogin(
      requestDetailPage({ params: Promise.resolve({ id: "req_missing" }) }),
      "/requests/req_missing",
    );
  });

  it("renders the dashboard for a signed-in employee", async () => {
    authMock.mockResolvedValueOnce(SESSION as never);

    await expect(dashboardPage()).resolves.toBeDefined();
  });

  it("renders the supplier panel for a signed-in employee", async () => {
    authMock.mockResolvedValueOnce(SESSION as never);

    await expect(suppliersPage()).resolves.toBeDefined();
  });

  it("renders the request detail for a signed-in employee", async () => {
    const request = createRequest(REQUEST);
    await runSourcingPipeline(request.id);
    authMock.mockResolvedValueOnce(SESSION as never);

    await expect(
      requestDetailPage({ params: Promise.resolve({ id: request.id }) }),
    ).resolves.toBeDefined();
  });

  it("answers a signed-in employee with a 404 for a request that does not exist", async () => {
    authMock.mockResolvedValueOnce(SESSION as never);

    try {
      await requestDetailPage({
        params: Promise.resolve({ id: "req_missing" }),
      });
    } catch (error) {
      const digest = (error as { digest?: string }).digest ?? "";
      expect(digest).toMatch(/404|NOT_FOUND/);
      return;
    }
    throw new Error("expected notFound() for an unknown request");
  });
});
