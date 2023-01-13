import type { IBlock } from "../../type.js";
import unblock from "@/services/blocking/delete.js";
import type { CacheableRemoteUser } from "@/models/entities/user.js";
import DbResolver from "../../db-resolver.js";
import { Users } from "@/models/index.js";

export default async (
	actor: CacheableRemoteUser,
	activity: IBlock,
): Promise<string> => {
	const dbResolver = new DbResolver();
	const blockee = await dbResolver.getUserFromApId(activity.object);

	if (blockee == null) {
		return "skip: blockee not found";
	}

	if (blockee.host != null) {
		return "skip: The user you are trying to unblock is not a local user";
	}

	await unblock(await Users.findOneByOrFail({ id: actor.id }), blockee);
	return "ok";
};
