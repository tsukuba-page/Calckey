export function createMfmNode(type: string, props: Record<string, any> = {}, children: MfmNode[] = []): MfmNode {
	return {
		type,
		props,
		children
	}
}

// eslint-disable-next-line no-useless-escape
export const urlRegex     = /^https?:\/\/[\w\/:%#@\$&\?!\(\)\[\]~\.,=\+\-]+/;
export const urlRegexFull = /^https?:\/\/[\w\/:%#@\$&\?!\(\)\[\]~\.,=\+\-]+$/;
