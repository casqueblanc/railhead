# Removing Railhead's sandboxes

Deleting the `railhead` Worker does not remove its sandboxes. The container application and its image stay in the account until they are deleted separately ([#12](https://github.com/casqueblanc/railhead/issues/12)). This is the owner's procedure; agents never run it.

What a deployment creates, as declared in `packages/railhead-backend/cloudflare.config.ts`:

| Resource              | Name                                             | Built from                              |
| --------------------- | ------------------------------------------------ | --------------------------------------- |
| Container application | `railhead-sandbox`                               | `containers/railhead/Dockerfile`        |
| Container image       | `railhead-sandbox:<tag>` in the managed registry | the same Dockerfile, one tag per deploy |
| Durable Object class  | `RailheadSandbox`, bound as `SANDBOX`            | `src/sandbox/sandboxObject.ts`          |

## Before deleting

Running sandboxes hold slots in each repository's `sandbox_slots` table. A slot left `uncertain` means a start, command or teardown was never confirmed, so its container may still be running. Deleting the application stops every container whatever the slots say; afterwards the slots are stale and must not be trusted.

## Steps

Run from `packages/railhead-backend`, logged in to the account that holds the deployment.

1. Delete the Worker:

   ```sh
   pnpm exec wrangler delete
   ```

2. Find the application's ID. `wrangler containers list` shows it under the name `railhead-sandbox`:

   ```sh
   pnpm exec wrangler containers list
   ```

3. Delete the application through the API. In the measured case `wrangler containers delete` rejected the ID of an application whose Worker was gone, while the API removed it:

   ```sh
   curl -X DELETE \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/containers/applications/<application-id>"
   ```

   Replace `<application-id>` with the ID from step 2. The token needs Containers edit permission.

4. Delete every image tag the deployments pushed:

   ```sh
   pnpm exec wrangler containers images list
   pnpm exec wrangler containers images delete railhead-sandbox:<tag>
   ```

5. Confirm that `wrangler containers list` no longer shows `railhead-sandbox` and that `wrangler containers images list` shows no `railhead-sandbox` tag.

The Artifacts namespace `railhead` holds repositories, not sandboxes, and is not removed by these steps.
