require('dotenv').config();

let Splitwise = require('splitwise');

let splitwise_group_name = process.argv[2];
let actual_budget_id = process.argv[3];
let actual_account_name = process.argv[4];
let from_time = process.argv[5];

let splitwise = Splitwise({
    consumerKey: process.env.SPLITWISE_CONSUMER_KEY,
    consumerSecret: process.env.SPLITWISE_CONSUMER_SECRET,
});

let actual = require('@actual-app/api');

function deleteTransaction(splitwise_id) {
    let query = actual
        .q('transactions')
        .filter({imported_id: splitwise_id.toString()})
        .select('*');
    return actual
        .runQuery(query)
        .then(response => {
            let id = response.data[0];
            if (id) {
                return actual
                    .deleteTransaction(id)
                    .then(console.log("deleted #" + splitwise_id));
            } else {
                console.log("skipped deleting #" + splitwise_id);
                return true;
            }
        })
        .catch(console.log);
}

function userName(user) {
    return [
        user.first_name,
        user.last_name
    ].filter(v => v).join(' ');
}

function createTransaction(splitwise_user_id, actual_account_id, expense) {
    let payee_ids = expense.repayments.flatMap(repayment => {
        if (repayment.from === splitwise_user_id) {
            return repayment.to;
        } else if (repayment.to === splitwise_user_id) {
            return repayment.from;
        } else {
            return [];
        }
    });
    let users = new Map(expense.users.map(user => [user.user_id, user]));
    let payee = payee_ids.length === 1
        ? userName(users.get(payee_ids[0]).user)
        : splitwise_group_name;
    let amount = parseFloat(users.get(splitwise_user_id).net_balance);
    let transaction = {
        account: actual_account_id,
        date: expense.date.split('T')[0],
        amount: Math.round(amount * 100),
        notes: expense.description,
        imported_id: expense.id,
        imported_payee: payee_ids.join(','),
        cleared: !expense.payment,
    }
    if (expense.payment) {
        transaction.notes = 'Payment from ' + payee;
    } else {
        transaction.payee_name = payee;
    }
    console.log("create "
        + (expense.payment ? "transfer #" : "transaction #") + expense.id);
    return transaction;
}

async function run(splitwise_user, expenses) {
    let actual_account_id = await actual.getAccounts().then(accounts =>
        accounts.find(acc => acc.name == actual_account_name).id);
    let new_expenses = [];
    let deletion_ids = [];
    expenses.forEach(expense => {
        if (expense.deleted_at) {
            deletion_ids.push(expense.id);
        } else {
            new_expenses.push(expense);
        }
    });
    if (deletion_ids.length > 0) {
        await Promise.all(deletion_ids.map(deleteTransaction));
    }
    let transactions = new_expenses.map(expense =>
        createTransaction(splitwise_user.id, actual_account_id, expense)
    );
    await actual.importTransactions(actual_account_id, transactions);
}

splitwise.getGroups().then(groups => {
    let group = groups.find(group => group.name === splitwise_group_name);
    if (!group) {
        throw 'No such group: ' + splitwise_group_name;
    }
    if (group.updated_at < from_time) {
        return [];
    }
    return Promise.all([
        splitwise.getCurrentUser(),
        splitwise.getExpenses({ group_id: group.id, updated_after: from_time }),
    ]);
}).then(results => {
    let [user, expenses] = results;
    actual.runWithBudget(actual_budget_id, () => run(user, expenses));
});
