<template>
	<Dialog v-model:open="show" size="sm">
		<template #title>
			<h3 class="text-2xl-semibold text-ink-gray-9">
				{{ __('Group Settings') }}
			</h3>
		</template>
		<template #default>
			<div class="flex items-center justify-between gap-4 rounded-md border border-outline-gray-2 p-3">
				<div>
					<p class="text-sm-medium text-ink-gray-8">{{ __('Owner Only') }}</p>
					<p class="text-xs text-ink-gray-5">
						{{ __("Hide this group and everything inside it from everyone except its owner and Admins.") }}
					</p>
				</div>
				<Switch v-model="ownerOnly" />
			</div>
		</template>
		<template #actions="{ close }">
			<div class="flex justify-end gap-2">
				<Button variant="outline" @click="close">
					{{ __('Cancel') }}
				</Button>
				<Button
					variant="solid"
					:disabled="!isDirty || docResource.setValue.loading"
					:loading="docResource.setValue.loading"
					@click="saveSettings"
				>
					{{ __('Save') }}
				</Button>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
import { Button, Dialog, Switch, toast } from 'frappe-ui';
import { computed, ref, watch } from 'vue';

const props = defineProps({
	// The document resource from createDocumentResource({ doctype: 'Wiki
	// Document', name }), created fresh per open by the caller (a group isn't
	// already loaded the way an open page is).
	docResource: {
		type: Object,
		required: true,
	},
});

const emit = defineEmits(['saved']);

const show = defineModel({ type: Boolean, default: false });

const ownerOnly = ref(false);

const isDirty = computed(() => {
	const doc = props.docResource.doc;
	if (!doc) return false;
	return ownerOnly.value !== Boolean(doc.owner_only);
});

// Reset from the doc every time the dialog opens, so stale edits from a
// cancelled session never leak into the next open.
watch(show, (isOpen) => {
	if (!isOpen) return;
	ownerOnly.value = Boolean(props.docResource.doc?.owner_only);
});

async function saveSettings() {
	try {
		await props.docResource.setValue.submit({ owner_only: ownerOnly.value ? 1 : 0 });
		toast.success(__('Group settings saved'));
		// This is a direct save outside the draft/change-request tree, so the
		// sidebar's cached copy of the flag (used for the Owner Only badge)
		// won't pick it up on its own -- let the caller patch it locally.
		emit('saved', ownerOnly.value);
	} catch (error) {
		toast.error(error.messages?.[0] || __('Error saving group settings'));
	}
}
</script>
