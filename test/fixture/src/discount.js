const logger = { info: () => {} };

function applyDiscount(price, customer) {
  logger.info("discount.applied", { price, vip: customer.isVip });
  if (price <= 0) return 0;
  const rate = customer.isVip ? 0.2 : 0;
  return Math.round(price * (1 - rate));
}

function allActive(customers) {
  if (customers.length === 0) return true;
  return customers.every((customer) => customer.active);
}

module.exports = { applyDiscount, allActive };
