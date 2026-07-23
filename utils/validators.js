function validateCampaign(data) {
  const errors = [];

  if (!data.title || data.title.trim().length < 3) {
    errors.push('Title must be at least 3 characters');
  }
  if (!data.description || data.description.trim().length < 10) {
    errors.push('Description must be at least 10 characters');
  }
  if (!data.goalAmount || data.goalAmount <= 0) {
    errors.push('Goal amount must be greater than 0');
  }
  if (!data.category) {
    errors.push('Category is required');
  }
  if (!data.endDate) {
    errors.push('End date is required');
  }
  if (data.endDate && new Date(data.endDate) <= new Date()) {
    errors.push('End date must be in the future');
  }

  return errors;
}

function validateContribution(data) {
  const errors = [];

  if (!data.campaignId) {
    errors.push('Campaign ID is required');
  }
  if (!data.amount || data.amount <= 0) {
    errors.push('Amount must be greater than 0');
  }

  return errors;
}

function validateWithdrawal(data) {
  const errors = [];

  if (!data.campaignId) {
    errors.push('Campaign ID is required');
  }
  if (!data.amount || data.amount <= 0) {
    errors.push('Amount must be greater than 0');
  }
  if (!data.bankDetails?.accountHolder) {
    errors.push('Account holder name is required');
  }
  if (!data.bankDetails?.accountNumber) {
    errors.push('Account number is required');
  }
  if (!data.bankDetails?.bankName) {
    errors.push('Bank name is required');
  }

  return errors;
}

function validateReport(data) {
  const errors = [];

  if (!data.targetType) {
    errors.push('Target type is required');
  }
  if (!data.targetId) {
    errors.push('Target ID is required');
  }
  if (!data.reason) {
    errors.push('Reason is required');
  }

  return errors;
}

module.exports = {
  validateCampaign,
  validateContribution,
  validateWithdrawal,
  validateReport,
};
