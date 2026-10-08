const { applyDiscount, allActive } = require("../../src/discount");

describe("applyDiscount", () => {
  it("takes 20% off for a VIP", () => {
    expect(applyDiscount(100, { isVip: true })).toBe(80);
  });

  it("charges the full price otherwise", () => {
    expect(applyDiscount(100, { isVip: false })).toBe(100);
  });

  it("never returns a negative price", () => {
    expect(applyDiscount(-5, { isVip: false })).toBe(0);
  });
});

describe("allActive", () => {
  it("is true for an active customer", () => {
    expect(allActive([{ active: true }])).toBe(true);
  });

  it("is false for an inactive customer", () => {
    expect(allActive([{ active: false }])).toBe(false);
  });

  it("is true for no customers", () => {
    expect(allActive([])).toBe(true);
  });
});
