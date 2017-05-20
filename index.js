const async = require('async');
const chalk = require('chalk');
const got = require('got');
const mongodb = require('mongodb');
const mongodbLock = require('mongodb-lock');
const sntp = require('sntp');
const sugarDate = require('sugar-date');

const config = require('./config.json');

const userRegex = new RegExp(`@${config.github.username}`, 'ig');
const userDateRegex = new RegExp(`^[\\t ]*@${config.github.username}(?:[\\t ]+([^\\r\\n]+?)(?:[\\t ]+to[\\t ]*[^\\r\\n]*)?)?$`, 'igum');
const userLower = config.github.username.toLowerCase();

const cannedLeadIns = [
	// Want to add some? Make sure they're cordial!
	'I didn\'t quite catch that. :frowning:',
	'Terribly sorry, but I didn\'t understand that. :flushed:',
	'Hmm, not sure what you meant there. :no_mouth:',
	'Hmm, something\'s not right there. :persevere:'
];

const ghAuth = {
	auth: `${config.github.username}:${config.github.token}`,
	headers: {
		'User-Agent': `${config.github.userAgent}`,
		Accept: 'application/vnd.github.squirrel-girl-preview'
	}
};

const mdbConnectString = `mongodb://${config.mongo.username}:${config.mongo.password}@${config.mongo.host}/${config.mongo.database}`;

const log = {
	info: (...args) => console.log(chalk.magenta('INFO:'), ...args),
	warn: (...args) => console.warn(chalk.yellow.bold('WARNING:'), ...args),
	error: (...args) => console.error(chalk.red.bold('ERROR:'), ...args),
	inspect: arg => console.log(require('util').inspect(arg, {colors: true, depth: null}))
};

function parseDate(body) {
	body = body.replace(/^[\s\t]*(at|on)[\s\t]+/, '');
	const date = sugarDate.Date.create(body, {future: true, past: false, fromUTC: true});
	if (date.getTime() <= Date.now()) {
		return new Date(NaN);
	}
	return date;
}

function makeBody(body) {
	const result = {};

	for (const k of Object.keys(ghAuth)) {
		result[k] = ghAuth[k];
	}

	result.body = JSON.stringify(body);
	return result;
}

mongodb.MongoClient.connect(mdbConnectString, (err, db) => {
	if (err) {
		throw err;
	}

	log.info('connected to database');

	const lock = mongodbLock(db, 'locks', 'process-notifications', {timeout: 120 * 1000});

	function processNotifications(cb) {
		async.waterfall([
			// Get the time from a dedicated NTP server (so we're always in sync)
			// cb => sntp.time({}, cb),
			// (timestamp, cb) => cb(null, timestamp.receivedLocally),

			// Get new notifications
			cb => got('https://api.github.com/notifications', ghAuth)
				.then(response => cb(null, JSON.parse(response.body)))
				.catch(cb),

			// Convert threads to groups of comments (includes issues, issue comments and PR comments all in one)
			(notifications, cb) => async.map(notifications.filter(n => n.reason === 'mention'),
				(n, cb) => got(`${n.subject.url}/comments`, ghAuth)
					.then(response => cb(null, JSON.parse(response.body)))
					.catch(cb),
				(err, results) => cb(err, notifications, results)),

			// Pool together all threads' comments into a single array
			(notifications, pools, cb) => cb(null, notifications, pools.reduce((arr, p) => arr.concat(p), [])),

			// De-duplicate comments by ID
			(notifications, comments, cb) => {
				const uniqued = comments.reduce((obj, c) => {
					obj[c.id] = c;
					return obj;
				}, {});

				const unique = [];
				for (const k of Object.keys(uniqued)) {
					unique.push(uniqued[k]);
				}

				cb(null, notifications, unique);
			},

			// Filter out comments with no mentions
			(notifications, comments, cb) => cb(null, notifications, comments.filter(c => c.body.search(userRegex) !== -1)),

			// Filter out comments that have already been reacted to (by us)
			(notifications, comments, cb) => async.reject(comments,
				(c, cb) => got(`${c.url}/reactions`, ghAuth)
					.then(response => {
						const reactions = JSON.parse(response.body);

						for (const reaction of reactions) {
							if (reaction.user.login.toLowerCase() === userLower) {
								return cb(null, true);
							}
						}

						cb(null, false);
					})
					.catch(cb),
				(err, results) => cb(err, notifications, results)),

			// Parse comments for username mentions; merge results into record
			(notifications, comments, cb) => cb(null, notifications, comments.map(
				c => {
					c.validDates = []; // Date objects
					c.invalidDates = []; // Bad strings
					let match = null;
					while ((match = userDateRegex.exec(c.body))) {
						if (!match[1]) {
							// Introductory comment will be posted.
							c.invalidDates.push('?');
							continue;
						}

						const date = parseDate(match[1]);
						if (isNaN(date.getTime())) {
							c.invalidDates.push(match[1]);
						} else {
							c.validDates.push(date);
						}
					}
					return c;
				})),

			// Convert each comment to action ({reaction: 'up'/'down', comment: null/'some response', record: mongodb_record, analytics: {...}})
			(notifications, comments, cb) => cb(null, notifications, comments.map(
				// eslint-disable-next-line complexity
				c => {
					const action = {
						reactions: [], // Make sure to have at least one, or else it'll send a million messages.
						comment: null,
						records: [],
						analytics: null
					};
					c.remindAction = action;

					let thumbsUp = false;
					let thumbsDown = false;
					let heart = false;
					let confused = false;
					let party = false;

					let intro = false;

					for (const date of c.validDates) {
						thumbsUp = true;
						// TODO add to mongo record
					}

					const trulyInvalid = [];
					for (let date of c.invalidDates) {
						date = date.trim();

						// You've managed to find some easter eggs. That's nice!
						//
						// Not only are these easter eggs, but they also cut down on
						// invalid message handling for when Humans(tm) try to use
						// @RemindMe by thanking it.
						//
						// Obviously not a silver bullet here, but maybe you'll have some fun.
						switch (date.toLowerCase()) {
							case '?':
								intro = true;
								break;
							case 'i love you':
								heart = true;
								break;
							case 'you rock!':
							case 'you\'re awesome!':
								party = true;
								break;
							case 'thanks':
							case 'thanks!':
								party = true;
								break;
							default:
								thumbsDown = true;
								trulyInvalid.push(date);
						}
					}

					if (thumbsUp && thumbsDown) {
						thumbsUp = false;
						thumbsDown = false;
						confused = true; // :)
					}

					// Should we comment?
					if (trulyInvalid.length > 0) {
						const lines = [
							cannedLeadIns[Math.floor(Math.random() * cannedLeadIns.length)],
							''
						];

						if (trulyInvalid.length === 1) {
							lines.push(`I don't quite understand _"${trulyInvalid[0]}"_. Care to try again?`);
						} else {
							lines.push('The following didn\'t make sense to me:');
							for (const str of trulyInvalid) {
								lines.push(`- ${str}`);
							}
						}

						if (c.validDates.length > 0) {
							const phrasing = c.validDates.length === 1 ? 'reminder' : `${c.validDates.length} reminders`;
							lines.push('');
							lines.push(`However, I scheduled the other ${phrasing} for you! :dancer:`);
						}

						action.comment = lines.join('\n');
					} else if (intro && c.validDates.length === 0) {
						party = true;
						/* eslint-disable operator-linebreak */
						action.comment = `Hey there, @${c.user.login}! I'm __RemindMe__, a robot that helps you remember to do things here on GitHub.`
							+ '\n\nIf you need to remember something, mention me with a time and (optionally) a reminder.'
							+ '\n\nSome examples of things I respond to:'
							+ '\n- _@RemindMe in 4 hours to check up on this PR._'
							+ '\n- _@RemindMe tomorrow to come back to this issue._'
							+ '\n- _@RemindMe on July 3rd to do a release._'
							+ '\n- _@RemindMe a year from today to update the copyright notice._'
							+ '\n\nIf all of the reminders in your comment are OK, I\'ll simply respond with a :+1: thumbs up.'
							+ ' Otherwise, I\'ll let you know what I didn\'t understand.'
							+ '\n\nThen when the time comes, I\'ll ping and remind you to come back and have a look! :metal:';
						/* eslint-enable operator-linebreak */
					}

					if (thumbsUp) {
						action.reactions.push('+1');
					}
					if (thumbsDown) {
						action.reactions.push('-1');
					}
					if (confused) {
						action.reactions.push('confused');
					}
					if (heart) {
						action.reactions.push('heart');
					}
					if (party) {
						action.reactions.push('hooray');
					}

					// TODO Analytics

					return c;
				})),

			// Parallel: Send Reaction + Comment / Mark as read / Commit record / Send analytics
			(notifications, comments, cb) => {
				// GitHub asks that we sparse out write requests to 1 second each.
				// For more information, see https://developer.github.com/guides/best-practices-for-integrators/#dealing-with-rate-limits
				//
				// Due to this, we create a queue object, limit it to 1 at a time, and then
				// spread out the payloads over 1-second intervals.
				const taskLimiter = async.queue(
					(fn, cb) => fn(err => setTimeout(() => cb(err), 1000)),
					1);

				async.each(comments,
					(c, cb) => async.parallel([
						cb => {
							log.info(`respond: ${c.url}`);
							cb();
						},

						// Mark as read
						cb => async.each(notifications,
							(n, cb) => taskLimiter.push(
								cb => got.patch(n.url, ghAuth)
									.then(() => cb())
									.catch(cb),
								cb),
							cb),

						// Comment
						cb => {
							if (c.remindAction.comment) {
								taskLimiter.push(
									cb => got.post(`${c.issue_url}/comments`, makeBody({body: c.remindAction.comment}))
										.then(() => cb())
										.catch(cb),
									cb);
							} else {
								cb();
							}
						},

						// Reactions
						cb => async.each(c.remindAction.reactions,
							(reaction, cb) => taskLimiter.push(
								cb => got.post(`${c.url}/reactions`, makeBody({content: reaction}))
									.then(() => cb())
									.catch(cb),
								cb),
							cb)

						// TODO MongoDB entries
						// TODO Analytics
					], cb),
				cb);
			},

			// Report rate limit
			cb => got('https://api.github.com/rate_limit', ghAuth)
				.then(response => cb(null, JSON.parse(response.body)))
				.catch(cb),
			(limits, cb) => {
				log.info(`${chalk.dim('rate limiting:')} ${chalk.bold(limits.rate.remaining)} out of ${chalk.bold(limits.rate.limit)} remaining; resets at ${chalk.bold(limits.rate.reset)}`);
				cb();
			}
		], cb);
	}

	function checkAll() {
		async.waterfall([
			// Acquire a lock
			cb => lock.acquire((err, code) => {
				if (err) {
					return cb(err);
				}
				log.info('acquired lock');
				cb(null, code);
			}),

			// Perform update tick
			(code, cb) => processNotifications(err => cb(err, code)),

			// Release lock
			(code, cb) => lock.release(code, (err, ok) => {
				if (err) {
					return cb(err);
				}

				if (ok) {
					log.info('released lock');
				} else {
					log.warn('could not release lock!');
				}

				cb();
			})
		], err => {
			if (err) {
				if (err.stack) {
					log.error(err.stack);
				} else {
					log.inspect(err);
				}
				if (err.response) {
					log.error(`URL: ${err.response.url}`);
					log.inspect(JSON.parse(err.response.body));
				}
			}

			setTimeout(checkAll, config.interval);
		});
	}

	checkAll();
});
