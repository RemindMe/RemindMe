const chalk = require('chalk');
const sugarDate = require('sugar-date');

const bodies = [
	'at 6:00pm on wednesday',
	'4 days from now',
	'16 years from now',
	'1 year from now',
	'half a day from now',
	'on July 4th',
	'in 2 hours',
	'in 2 hours and 15 seconds',
	'in 4 second',
	'in 1 second',
	'in 3 weeks',
	'in a week',
	'in a seconds',
	'in a second',
	'on the 5th',
	'5 hours from now',
	'on saturday',
	'on SaTuRdAy',
	'123455',
	'now',
	'in 1954',
	'in a century',
	'in a week',
	'six years from now',
	'in three months',
	'in 555 days',
	'14 years from now'
];

function parseDate(body) {
	body = body.replace(/^[\s\t]*(at|on)[\s\t]+/, '');
	const date = sugarDate.Date.create(body, {future: true, past: false});
	if (date.getTime() <= Date.now()) {
		return new Date(NaN);
	}
	return date;
}

for (const body of bodies) {
	const date = parseDate(body);
	if (isNaN(date.getTime())) {
		console.log(chalk.bold(body), '->', chalk.red('FAIL'));
	} else {
		console.log(
			chalk.bold(body),
			'->',
			require('util').inspect(date, {depth: null, colors: true}));
	}
}
