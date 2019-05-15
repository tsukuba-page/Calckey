import $ from 'cafy';
import * as mongo from 'mongodb';
import Note from '../../../../models/note';
import { packMany } from '../../../../models/note';
import es from '../../../../db/elasticsearch';
import define from '../../define';
import { ApiError } from '../../error';
import User, { IUser, ILocalUser } from '../../../../models/user';
import { toDbHost, isSelfHost } from '../../../../misc/convert-host';
import Following from '../../../../models/following';
import { concat } from '../../../../prelude/array';
import { getHideUserIds } from '../../common/get-hide-users';
import { getFriends } from '../../common/get-friends';
const escapeRegexp = require('escape-regexp');

export const meta = {
	desc: {
		'ja-JP': '投稿を検索します。',
		'en-US': 'Search notes.'
	},

	tags: ['notes'],

	requireCredential: false,

	params: {
		query: {
			validator: $.str
		},

		limit: {
			validator: $.optional.num.range(1, 100),
			default: 10
		},

		offset: {
			validator: $.optional.num.min(0),
			default: 0
		}
	},

	res: {
		type: 'array',
		items: {
			type: 'Note',
		},
	},

	errors: {
		searchingNotAvailable: {
			message: 'Searching not available.',
			code: 'SEARCHING_NOT_AVAILABLE',
			id: '7ee9c119-16a1-479f-a6fd-6fab00ed946f'
		}
	}
};

export default define(meta, async (ps, me) => {
	const internal = await searchInternal(me, ps.query, ps.limit, ps.offset).catch(e => {
		console.warn(e);
		throw e;
	});
	if (internal !== null) return internal;

	if (es == null) throw new ApiError(meta.errors.searchingNotAvailable);

	const response = await es.search({
		index: 'misskey',
		type: 'note',
		body: {
			size: ps.limit,
			from: ps.offset,
			query: {
				simple_query_string: {
					fields: ['text'],
					query: ps.query,
					default_operator: 'and'
				}
			},
			sort: [
				{ _doc: 'desc' }
			]
		}
	});

	if (response.hits.total === 0) {
		return [];
	}

	const hits = response.hits.hits.map(hit => new mongo.ObjectID(hit._id));

	// Fetch found notes
	const notes = await Note.find({
		_id: {
			$in: hits
		}
	}, {
		sort: {
			_id: -1
		}
	});

	return await packMany(notes, me);
});

async function searchInternal(me: ILocalUser, query: string, limit: number, offset: number) {
	// extract tokens
	const tokens = query.trim().split(/\s+/);
	const words: string[] = [];
	let from: IUser = null;
	let since: Date = null;
	let until: Date = null;
	let types: string[] = [];
	let withFiles = false;
	let host: string;	// = undefined
	let sensitive: 'all' | 'sfw' | 'nsfw' = 'all';
	let filtered = false;
	let withPolls = false;

	for (const token of tokens) {
		// from
		const matchFrom = token.match(/^from:@?([\w-]+)(?:@([\w.-]+))?$/);
		if (matchFrom) {
			const user = await User.findOne({
				usernameLower: matchFrom[1].toLowerCase(),
				host: toDbHost(matchFrom[2]),
			});

			if (user == null) return [];	// fromが存在しないユーザーならno match
			from = user;

			filtered = true;
			continue;
		}

		// Date
		const matchSince = token.match(/^since:(\d{4}-\d{1,2}-\d{1,2}.*)/);
		if (matchSince) {
			since = new Date(matchSince[1]);

			filtered = true;
			continue;
		}

		const matchUntil = token.match(/^until:(\d{4}-\d{1,2}-\d{1,2}.*)/);
		if (matchUntil) {
			until = new Date(matchUntil[1]);

			filtered = true;
			continue;
		}

		// filter
		const matchFilter = token.match(/^filter:(\w+)$/);
		if (matchFilter) {
			// files
			if (matchFilter[1] === 'files') {
				withFiles = true;
			}

			// medias (images/videos/audios)
			if (matchFilter[1] === 'medias' || matchFilter[1] === 'images') {
				types = concat([types, ['image/jpeg', 'image/gif', 'image/png']]);
			}
			if (matchFilter[1] === 'medias' || matchFilter[1] === 'videos') {
				types = concat([types, ['video/mp4', 'video/webm']]);
			}
			if (matchFilter[1] === 'medias' || matchFilter[1] === 'audios') {
				types = concat([types, ['audio/mpeg', 'audio/mp4']]);
			}

			if (matchFilter[1] === 'polls') {
				withPolls = true;
			}

			filtered = true;
			continue;
		}

		// sensitive
		const matchSensitive = token.match(/^sensitive:(all|sfw|nsfw)$/);
		if (matchSensitive) {
			sensitive = matchSensitive[1] as 'all' | 'sfw' | 'nsfw';

			// filteredにしない
			continue;
		}

		// host
		const matchHost = token.match(/^host:([\w.-]+)$/);
		if (matchHost) {
			if (matchHost[1].match(/^(\.|local)$/) || isSelfHost(matchHost[1])) {
				host = null;
			} else {
				host = toDbHost(matchHost[1]);
			}

			filtered = true;
			continue;
		}

		words.push(token);
	}

	// フィルタ系が指定されていないワード検索の場合
	if (!filtered && words.length > 0) {
		// ESがあればそちらに任せる
		if (es) return null;

		// なければ期間を縮めてDB検索
		since = new Date(Date.now() - 7 * 86400 * 1000);
	}

	// constract query
	const [followings, hideUserIds] = await Promise.all([
		// フォローを取得
		// Fetch following
		getFriends(me._id),

		// 隠すユーザーを取得
		getHideUserIds(me)
	]);

	const followQuery = followings.map(f => ({
		userId: f.id,
	}));

	const visibleQuery = me == null ? [{
		visibility: { $in: ['public', 'home'] }
	}] : [{
		visibility: {
			$in: ['public', 'home']
		}
	}, {
		$and: [
			{ visibility: 'followers' },
			{ $or: followQuery }
		]
	}, {
		// myself (for specified/private)
		userId: me._id
	}, {
		// to me (for specified)
		visibleUserIds: { $in: [ me._id ] }
	}];

	// note
	const noteQuery = {
		$and: [ {} ],
		deletedAt: null,
		$or: visibleQuery
	} as any;

	// note - userId
	if (from != null) {
		noteQuery.userId = from._id;
	} else {
		noteQuery.userId = { $nin: hideUserIds };
	}

	// Date
	if (since) {
		noteQuery.$and.push({ createdAt: { $gt: since } });
	}

	if (until) {
		noteQuery.$and.push({ createdAt: { $lt: until } });
	}

	// note - files / medias
	if (withFiles) {
		noteQuery.fileIds = { $exists: true, $ne: [] };
	} else if (types.length > 0) {
		noteQuery.fileIds = { $exists: true, $ne: [] };

		noteQuery['_files.contentType'] = {
			$in: types
		};
	}

	// note - polls
	if (withPolls) {
		noteQuery.poll = { $exists: true, $ne: null };
	}

	if (noteQuery.fileIds && sensitive === 'sfw') {
		noteQuery['_files.metadata.isSensitive'] = { $ne: true };
	}

	if (noteQuery.fileIds && sensitive === 'nsfw') {
		noteQuery['_files.metadata.isSensitive'] = true;
	}

	// note - host
	if (typeof host != 'undefined') {
		noteQuery['_user.host'] = host;
	}

	// note - words
	for (const word of words) {
		noteQuery.$and.push({
			text: new RegExp(escapeRegexp(word), 'i')
		});
	}

	//console.log(JSON.stringify(noteQuery, null, 2));

	const notes = await Note.find(noteQuery, {
		maxTimeMS: 20000,
		limit,
		skip: offset,
		sort: { createdAt: -1 },
	});

	return await packMany(notes, me);
}
