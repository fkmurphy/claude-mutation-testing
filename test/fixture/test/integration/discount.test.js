const { cleanDb, insertCustomer, allCustomers } = require("../../src/db");
const { allActive } = require("../../src/discount");

beforeEach(() => cleanDb());

it("is false when one stored customer is inactive", async () => {
  insertCustomer({ active: true });
  insertCustomer({ active: false });
  // The window in which a runner sharing this database would clean or fill it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const customers = allCustomers();
  expect(customers).toHaveLength(2);
  expect(allActive(customers)).toBe(false);
});
